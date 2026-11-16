import pg from "pg";

const TENANT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BOUNDED_ROLES = ["app_reader", "pipeline_agent", "executor_service", "verifier_agent", "control_plane"];
const MAX_STATEMENT_TIMEOUT_MS = 600_000;

/**
 * A `KnowledgeDatabase` for integration tests on a database whose data must be left as found. One connection holds
 * one outer transaction that is rolled back by `close()`; every `transaction(scope, work)` is a savepoint inside it,
 * entered with the same tenant, role, read-only and timeout settings `TenantPostgres` applies. A returning `work`
 * "commits": deferred constraints fire (`set constraints all immediate`) under the scope's role, the savepoint is
 * released, and the initially-deferred constraints are deferred again for the next scope. A throwing `work`, or a
 * deferred constraint that refuses, rolls the savepoint back.
 *
 * Differences from real transactions, to keep in mind when reading a result: every scope shares one
 * `pg_current_xact_id()` and one snapshot lineage (a later scope sees an earlier scope's rows, as after a commit);
 * `isolationLevel` is not applied (PostgreSQL refuses it inside a subtransaction); scopes run one at a time.
 */
export class RollbackPostgres {
  #client;
  #initiallyDeferred;
  #tail = Promise.resolve();
  #savepoints = 0;
  #closed = false;

  constructor(client, initiallyDeferred) {
    this.#client = client;
    this.#initiallyDeferred = initiallyDeferred;
  }

  static async open(config) {
    const connectionString = typeof config === "string" ? config : config.connectionString;
    const url = new URL(connectionString);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !["localhost", "127.0.0.1"].includes(url.hostname))
      throw new Error("ROLLBACK_POSTGRES_LOOPBACK_REQUIRED");
    const client = new pg.Client({ connectionString, application_name: "ks-rollback-integration-test" });
    await client.connect();
    const deferred = await client.query(
      `select distinct format('%I.%I', n.nspname, c.conname) as name
         from pg_constraint c join pg_namespace n on n.oid = c.connamespace
        where c.condeferrable and c.condeferred order by 1`,
    );
    await client.query("begin");
    return new RollbackPostgres(
      client,
      deferred.rows.map((row) => row.name),
    );
  }

  /** The connection itself, for fixture rows a test inserts (as the login role) inside the outer transaction. */
  get client() {
    return this.#client;
  }

  transaction(scope, work) {
    const run = this.#tail.then(() => this.#scoped(scope, work));
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #scoped(scope, work) {
    if (this.#closed) throw new Error("ROLLBACK_POSTGRES_CLOSED");
    if (!TENANT_UUID.test(scope.tenantId)) throw new Error("INVALID_TENANT_CONTEXT");
    if (scope.role !== undefined && !BOUNDED_ROLES.includes(scope.role)) throw new Error(`ROLE_DENIED:${scope.role}`);
    const client = this.#client;
    this.#savepoints += 1;
    const savepoint = `ks_scope_${this.#savepoints}`;
    await client.query(`savepoint ${savepoint}`);
    try {
      if (scope.readOnly) await client.query("set transaction read only");
      await client.query("select set_config('app.tenant_id',$1,true)", [scope.tenantId]);
      if (scope.statementTimeoutMs !== undefined) {
        const ms = scope.statementTimeoutMs;
        if (!Number.isInteger(ms) || ms < 1 || ms > MAX_STATEMENT_TIMEOUT_MS)
          throw new Error("INVALID_STATEMENT_TIMEOUT");
        await client.query(`set local statement_timeout = ${ms}`);
      }
      if (scope.role) await client.query(`set local role ${scope.role}`);
      const result = await work(client);
      try {
        await client.query("set constraints all immediate");
      } catch (error) {
        // `work` swallowed a failed statement: a real COMMIT of that aborted transaction rolls back without raising.
        if (error?.code !== "25P02") throw error;
        await client.query(`rollback to savepoint ${savepoint}`);
      }
      await client.query(`release savepoint ${savepoint}`);
      return result;
    } catch (error) {
      await client.query(`rollback to savepoint ${savepoint}`);
      await client.query(`release savepoint ${savepoint}`);
      throw error;
    } finally {
      await client.query("reset role");
      await client.query("set local statement_timeout = 0");
      await client.query("select set_config('app.tenant_id','',true)");
      if (this.#initiallyDeferred.length > 0)
        await client.query(`set constraints ${this.#initiallyDeferred.join(", ")} deferred`);
    }
  }

  async migrationHead() {
    const run = this.#tail.then(async () => {
      const result = await this.#client.query(
        "select max(version)::text version from supabase_migrations.schema_migrations",
      );
      return result.rows[0]?.version ?? undefined;
    });
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Rolls the outer transaction back: nothing any scope wrote survives. */
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    await this.#tail;
    try {
      await this.#client.query("rollback");
    } finally {
      await this.#client.end();
    }
  }
}
