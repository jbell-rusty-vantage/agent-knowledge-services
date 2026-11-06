import { Client } from "pg";
import type { Component } from "./component.js";

/**
 * Fail-closed installer for the `knowledge_verification` component (protocol knowledge-verification-sql/v1).
 *
 * One transaction: advisory lock, server-version check, receipts compared byte-for-byte, pending migrations applied in
 * order, receipts and the installation row written, commit. Any mismatch refuses before changing anything:
 * `MIGRATION_BYTES_DIFFER` (an applied file was edited), `UNKNOWN_RECEIPT` (the database holds a migration this
 * component does not know), `INSTALLATION_MISMATCH` (a different application/installation already owns the schema),
 * `SCHEMA_WITHOUT_RECEIPTS` (the schema exists but no ledger: not ours to upgrade), `POSTGRES_VERSION_UNSUPPORTED`.
 *
 * The admin DSN is passed by the caller (resolved from an environment variable NAME by the CLI); it is never logged.
 */
export interface InstallTarget {
  readonly adminDsn: string;
  readonly installationId: string;
  readonly applicationId: string;
  readonly binding: string;
  readonly appliedBy?: string;
}

export interface InstallReceipt {
  readonly component: string;
  readonly componentVersion: string;
  readonly componentDigest: string;
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
  readonly installationId: string;
  readonly applicationId: string;
  readonly binding: string;
  readonly serverVersion: number;
}

export class InstallRefused extends Error {
  readonly code: string;
  constructor(code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "InstallRefused";
    this.code = code;
  }
}

const ADVISORY_LOCK_KEY = 7_204_2026; // knowledge_verification installer lock

async function withClient<T>(dsn: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: dsn, application_name: "knowledge-db-installer" });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function schemaExists(client: Client, schema: string): Promise<boolean> {
  const result = await client.query<{ n: string }>("select count(*)::text as n from pg_namespace where nspname = $1", [
    schema,
  ]);
  return result.rows[0]?.n === "1";
}

async function tableExists(client: Client, schema: string, table: string): Promise<boolean> {
  const result = await client.query<{ n: string }>(
    "select count(*)::text as n from pg_tables where schemaname = $1 and tablename = $2",
    [schema, table],
  );
  return result.rows[0]?.n === "1";
}

export async function install(component: Component, target: InstallTarget): Promise<InstallReceipt> {
  return withClient(target.adminDsn, async (client) => {
    const version = Number(
      (await client.query<{ server_version_num: string }>("show server_version_num")).rows[0]?.server_version_num ?? 0,
    );
    if (version < component.spec.min_postgres_version) {
      throw new InstallRefused(
        "POSTGRES_VERSION_UNSUPPORTED",
        `server ${version} < ${component.spec.min_postgres_version}`,
      );
    }
    await client.query("begin");
    try {
      await client.query("select pg_advisory_xact_lock($1)", [ADVISORY_LOCK_KEY]);
      await client.query("set local search_path = pg_catalog, pg_temp");
      await client.query("set local lock_timeout = '30s'");
      await client.query("set local statement_timeout = '600s'");
      const applied: string[] = [];
      const skipped: string[] = [];
      const hasSchema = await schemaExists(client, "knowledge_verification");
      const hasLedger = hasSchema && (await tableExists(client, "knowledge_verification", "component_release"));
      if (hasSchema && !hasLedger) {
        throw new InstallRefused("SCHEMA_WITHOUT_RECEIPTS", "knowledge_verification exists without a component ledger");
      }
      const receipts = new Map<string, string>();
      if (hasLedger) {
        const rows = await client.query<{ migration_key: string; sha256: string }>(
          "select migration_key, sha256 from knowledge_verification.component_release where component = 'knowledge_verification'",
        );
        for (const row of rows.rows) receipts.set(row.migration_key, row.sha256);
        const known = new Set(component.migrations.map((m) => m.key));
        for (const key of receipts.keys()) {
          if (!known.has(key)) throw new InstallRefused("UNKNOWN_RECEIPT", key);
        }
        const installation = await client.query<{ installation_id: string; application_id: string; binding: string }>(
          "select installation_id::text, application_id, binding from knowledge_verification.installation",
        );
        const row = installation.rows[0];
        if (
          row &&
          (row.installation_id !== target.installationId ||
            row.application_id !== target.applicationId ||
            row.binding !== target.binding)
        ) {
          throw new InstallRefused("INSTALLATION_MISMATCH", `${row.application_id}/${row.installation_id}`);
        }
      }
      let pendingSeen = false;
      for (const migration of component.migrations) {
        const receipt = receipts.get(migration.key);
        if (receipt !== undefined) {
          if (pendingSeen) throw new InstallRefused("RECEIPT_GAP", migration.key);
          if (receipt !== migration.sha256) throw new InstallRefused("MIGRATION_BYTES_DIFFER", migration.key);
          skipped.push(migration.key);
          continue;
        }
        pendingSeen = true;
        await client.query(migration.sql);
        await client.query(
          "insert into knowledge_verification.component_release (component, component_version, migration_key, sha256, applied_by) values ('knowledge_verification', $1, $2, $3, $4)",
          [component.spec.component_version, migration.key, migration.sha256, target.appliedBy ?? "knowledge-db"],
        );
        applied.push(migration.key);
      }
      await client.query(
        "insert into knowledge_verification.installation (installation_id, application_id, binding) values ($1::uuid, $2, $3) on conflict (singleton) do nothing",
        [target.installationId, target.applicationId, target.binding],
      );
      await client.query("commit");
      return {
        component: component.spec.component,
        componentVersion: component.spec.component_version,
        componentDigest: component.manifest.component_digest,
        applied,
        skipped,
        installationId: target.installationId,
        applicationId: target.applicationId,
        binding: target.binding,
        serverVersion: version,
      };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    }
  });
}

export interface Inspection {
  readonly installed: boolean;
  readonly receipts: readonly { migration_key: string; sha256: string; component_version: string }[];
  readonly installation: { installation_id: string; application_id: string; binding: string } | null;
  readonly complete: boolean;
}

export async function inspect(component: Component, adminDsn: string): Promise<Inspection> {
  return withClient(adminDsn, async (client) => {
    if (!(await tableExists(client, "knowledge_verification", "component_release"))) {
      return { installed: false, receipts: [], installation: null, complete: false };
    }
    const receipts = (
      await client.query<{ migration_key: string; sha256: string; component_version: string }>(
        "select migration_key, sha256, component_version from knowledge_verification.component_release order by migration_key",
      )
    ).rows;
    const installation =
      (
        await client.query<{ installation_id: string; application_id: string; binding: string }>(
          "select installation_id::text, application_id, binding from knowledge_verification.installation",
        )
      ).rows[0] ?? null;
    const complete =
      receipts.length === component.migrations.length &&
      component.migrations.every((m, i) => receipts[i]?.migration_key === m.key && receipts[i]?.sha256 === m.sha256);
    return { installed: true, receipts, installation, complete };
  });
}
