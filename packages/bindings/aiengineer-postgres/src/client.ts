import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from "pg";

/**
 * Tenant-scoped, role-bounded transactions against a database that hosts the `knowledge_verification` component.
 * The pool connects as the configured login user; every unit of work runs inside one transaction with
 * `app.tenant_id` set (the component's forced RLS reads it) and, when configured, `set local role <bounded role>`.
 * Role separation never leaks across transactions. Mirrors the existing KS `TenantPostgres` discipline.
 */
export const COMPONENT_ROLES = [
  "knowledge_verification_reader",
  "knowledge_verification_writer",
  "knowledge_verification_reviewer",
  "knowledge_verification_outbox_worker",
] as const;
export type ComponentRole = (typeof COMPONENT_ROLES)[number];

/** AI Engineer bounded roles that inherit component roles through the binding migration (20261024010000). */
export const APPLICATION_ROLES = [
  "app_reader",
  "pipeline_agent",
  "executor_service",
  "verifier_agent",
  "control_plane",
] as const;
export type ApplicationRole = (typeof APPLICATION_ROLES)[number];

export type BoundedRole = ComponentRole | ApplicationRole;

const TENANT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NIL_TENANT = "00000000-0000-0000-0000-000000000000";

export interface Scope {
  readonly tenantId: string;
  readonly role: BoundedRole;
  readonly readOnly?: boolean;
  readonly statementTimeoutMs?: number;
}

export interface SqlClient {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

export function assertTenantId(tenantId: string): void {
  if (!TENANT_UUID.test(tenantId) || tenantId === NIL_TENANT) throw new Error("INVALID_TENANT_CONTEXT");
}

export function assertBoundedRole(role: string): asserts role is BoundedRole {
  if (
    !(COMPONENT_ROLES as readonly string[]).includes(role) &&
    !(APPLICATION_ROLES as readonly string[]).includes(role)
  ) {
    throw new Error(`ROLE_DENIED:${role}`);
  }
}

export interface ComponentDatabaseConfig {
  readonly connectionString: string;
  readonly maximumPoolSize?: number;
  readonly applicationName?: string;
}

export class ComponentDatabase {
  readonly #pool: Pool;

  constructor(config: ComponentDatabaseConfig) {
    const url = new URL(config.connectionString);
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new Error("POSTGRES_URL_DENIED");
    const poolConfig: PoolConfig = {
      connectionString: config.connectionString,
      max: config.maximumPoolSize ?? 6,
      application_name: config.applicationName ?? "knowledge-binding-aiengineer-postgres",
    };
    this.#pool = new Pool(poolConfig);
  }

  /** One transaction under one tenant and one bounded role; commits on return, rolls back on throw. */
  async transaction<T>(scope: Scope, work: (client: SqlClient) => Promise<T>): Promise<T> {
    assertTenantId(scope.tenantId);
    assertBoundedRole(scope.role);
    const client: PoolClient = await this.#pool.connect();
    try {
      await client.query("begin");
      if (scope.readOnly) await client.query("set transaction read only");
      await client.query("select set_config('app.tenant_id', $1, true)", [scope.tenantId]);
      if (scope.statementTimeoutMs !== undefined) {
        if (
          !Number.isInteger(scope.statementTimeoutMs) ||
          scope.statementTimeoutMs < 1 ||
          scope.statementTimeoutMs > 600_000
        ) {
          throw new Error("INVALID_STATEMENT_TIMEOUT");
        }
        await client.query(`set local statement_timeout = ${scope.statementTimeoutMs}`);
      }
      await client.query(`set local role ${scope.role}`);
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

  async end(): Promise<void> {
    await this.#pool.end();
  }
}
