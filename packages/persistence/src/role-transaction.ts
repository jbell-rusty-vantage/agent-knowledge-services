import { Pool, type PoolConfig } from "pg";
import type { TenantSqlClient } from "./postgres.js";

/**
 * Tenant-scoped Postgres transactions that switch to a bounded database role
 * *inside* the transaction (`set local role`). The pool itself always connects as
 * the configured login user; role separation never leaks across transactions.
 */

export const BOUNDED_ROLES = [
  "app_reader",
  "pipeline_agent",
  "executor_service",
  "verifier_agent",
  "control_plane",
] as const;
export type BoundedRole = (typeof BOUNDED_ROLES)[number];

export interface TransactionScope {
  readonly tenantId: string;
  readonly role?: BoundedRole;
  readonly readOnly?: boolean;
  readonly isolationLevel?: "read committed" | "repeatable read";
  readonly statementTimeoutMs?: number;
}

export interface TenantPostgresConfig {
  readonly connectionString: string;
  readonly maximumPoolSize?: number;
  readonly connectionTimeoutMs?: number;
  readonly applicationName?: string;
}

const TENANT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NIL_TENANT = "00000000-0000-0000-0000-000000000000";
const MAX_STATEMENT_TIMEOUT_MS = 600_000;

export function assertTenantId(tenantId: string): void {
  if (!TENANT_UUID.test(tenantId) || tenantId === NIL_TENANT) throw new Error("INVALID_TENANT_CONTEXT");
}

export function assertBoundedRole(role: string): asserts role is BoundedRole {
  if (!(BOUNDED_ROLES as readonly string[]).includes(role)) throw new Error(`ROLE_DENIED:${role}`);
}

function assertStatementTimeout(ms: number): void {
  if (!Number.isInteger(ms) || ms < 1 || ms > MAX_STATEMENT_TIMEOUT_MS) throw new Error("INVALID_STATEMENT_TIMEOUT");
}

async function enterScope(client: TenantSqlClient, scope: TransactionScope): Promise<void> {
  await client.query("begin");
  if (scope.isolationLevel) {
    if (scope.isolationLevel !== "read committed" && scope.isolationLevel !== "repeatable read")
      throw new Error("INVALID_TRANSACTION_ISOLATION");
    await client.query(`set transaction isolation level ${scope.isolationLevel}`);
  }
  if (scope.readOnly) await client.query("set transaction read only");
  await client.query("select set_config('app.tenant_id',$1,true)", [scope.tenantId]);
  if (scope.statementTimeoutMs !== undefined) {
    assertStatementTimeout(scope.statementTimeoutMs);
    await client.query(`set local statement_timeout = ${scope.statementTimeoutMs}`);
  }
  if (scope.role) {
    assertBoundedRole(scope.role);
    await client.query(`set local role ${scope.role}`);
  }
}

export class TenantPostgres {
  readonly #pool: Pool;

  constructor(config: TenantPostgresConfig) {
    const url = new URL(config.connectionString);
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new Error("POSTGRES_URL_DENIED");
    const poolConfig: PoolConfig = {
      connectionString: config.connectionString,
      max: config.maximumPoolSize ?? 6,
      connectionTimeoutMillis: config.connectionTimeoutMs ?? 5_000,
      application_name: config.applicationName ?? "ai-engineer-knowledge-executor",
    };
    this.#pool = new Pool(poolConfig);
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }

  /** Runs `work` in one transaction under the scope's tenant, role, and read-only/timeout settings. */
  async transaction<T>(scope: TransactionScope, work: (client: TenantSqlClient) => Promise<T>): Promise<T> {
    assertTenantId(scope.tenantId);
    const client = await this.#pool.connect();
    try {
      await enterScope(client, scope);
      const result = await work(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Superuser-free probe that needs no tenant: the applied migration head. */
  async migrationHead(): Promise<string | undefined> {
    const result = await this.#pool.query<{ version: string }>(
      "select max(version)::text version from supabase_migrations.schema_migrations",
    );
    return result.rows[0]?.version ?? undefined;
  }
}
