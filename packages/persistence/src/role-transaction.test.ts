import { beforeEach, describe, expect, it, vi } from "vitest";

// TenantPostgres is the transaction adapter knowledge-db consumes through its KnowledgeDatabase port.
const pool = vi.hoisted(() => ({
  statements: [] as { sql: string; values?: readonly unknown[] }[],
  released: 0,
  ended: 0,
  failOn: undefined as string | undefined,
  /** What `api.database_release()` answers; `undefined` means the database has no such function. */
  release: undefined as unknown,
}));
vi.mock("pg", () => ({
  Pool: class {
    async connect() {
      return {
        async query(sql: string, values?: readonly unknown[]) {
          pool.statements.push({ sql, ...(values ? { values } : {}) });
          if (pool.failOn && sql.startsWith(pool.failOn)) throw new Error(`FAILED:${sql}`);
          if (sql.includes("to_regprocedure")) return { rows: [{ ok: pool.release !== undefined }], rowCount: 1 };
          if (sql === "select api.database_release() as r") return { rows: [{ r: pool.release }], rowCount: 1 };
          return { rows: [], rowCount: 0 };
        },
        release() {
          pool.released++;
        },
      };
    }
    async query() {
      return { rows: [{ version: "20260913020000" }] };
    }
    async end() {
      pool.ended++;
    }
  },
}));
const { TenantPostgres } = await import("./role-transaction.js");

const tenantId = "018f0c4e-9b7a-7c3d-8e2f-1a2b3c4d5e6f";
const database = () => new TenantPostgres({ connectionString: "postgresql://localhost:5432/postgres" });
const sql = () => pool.statements.map((statement) => statement.sql);

beforeEach(() => {
  pool.statements = [];
  pool.released = 0;
  pool.ended = 0;
  pool.failOn = undefined;
  pool.release = undefined;
});

describe("tenant-scoped bounded-role transactions", () => {
  it("enters the tenant, isolation, read-only, timeout and role scope before the work, then commits", async () => {
    const result = await database().transaction(
      {
        tenantId,
        role: "executor_service",
        readOnly: true,
        isolationLevel: "repeatable read",
        statementTimeoutMs: 30_000,
      },
      async (client) => {
        await client.query("select 1");
        return "done";
      },
    );
    expect(result).toBe("done");
    expect(sql()).toEqual([
      "begin",
      "set transaction isolation level repeatable read",
      "set transaction read only",
      "select set_config('app.tenant_id',$1,true)",
      "set local statement_timeout = 30000",
      "set local role executor_service",
      "select 1",
      "commit",
    ]);
    expect(pool.statements[3]!.values).toEqual([tenantId]);
    expect(pool.released).toBe(1);
  });

  it("rolls back, releases and rethrows when the work fails", async () => {
    await expect(
      database().transaction({ tenantId }, async () => {
        throw new Error("WORK_FAILED");
      }),
    ).rejects.toThrow("WORK_FAILED");
    expect(sql()).toEqual(["begin", "select set_config('app.tenant_id',$1,true)", "rollback"]);
    expect(pool.released).toBe(1);
  });

  it("keeps the original failure when rollback also fails", async () => {
    pool.failOn = "rollback";
    await expect(
      database().transaction({ tenantId }, async () => {
        throw new Error("WORK_FAILED");
      }),
    ).rejects.toThrow("WORK_FAILED");
    expect(pool.released).toBe(1);
  });

  it("rejects an invalid or nil tenant before connecting", async () => {
    for (const invalid of ["tenant", "00000000-0000-0000-0000-000000000000"]) {
      await expect(database().transaction({ tenantId: invalid }, async () => "never")).rejects.toThrow(
        "INVALID_TENANT_CONTEXT",
      );
    }
    expect(pool.statements).toEqual([]);
  });

  it("denies roles outside the bounded set and invalid statement timeouts inside the transaction", async () => {
    await expect(database().transaction({ tenantId, role: "postgres" as never }, async () => "never")).rejects.toThrow(
      "ROLE_DENIED:postgres",
    );
    expect(sql()).not.toContain("set local role postgres");
    expect(sql().at(-1)).toBe("rollback");
    pool.statements = [];
    await expect(
      database().transaction({ tenantId, statementTimeoutMs: 600_001 }, async () => "never"),
    ).rejects.toThrow("INVALID_STATEMENT_TIMEOUT");
    expect(sql().at(-1)).toBe("rollback");
    expect(pool.released).toBe(2);
  });

  it("reads the migration head without a tenant and closes the pool", async () => {
    const db = database();
    await expect(db.migrationHead()).resolves.toBe("20260913020000");
    await db.close();
    expect(pool.ended).toBe(1);
  });

  it("asks the database for its release without a tenant or a transaction, and releases the client", async () => {
    await expect(database().databaseRelease()).resolves.toBeNull();
    expect(sql()).toEqual(["select to_regprocedure('api.database_release()') is not null as ok"]);
    pool.statements = [];
    pool.release = { format: "ai-engineer-database-release/1", release: "0.12.0", state: "current" };
    await expect(database().databaseRelease()).resolves.toEqual(pool.release);
    expect(sql()).toEqual([
      "select to_regprocedure('api.database_release()') is not null as ok",
      "select api.database_release() as r",
    ]);
    pool.failOn = "select api.database_release()";
    await expect(database().databaseRelease()).rejects.toThrow("FAILED:select api.database_release() as r");
    expect(pool.released).toBe(3);
  });

  it("refuses non-Postgres connection strings", () => {
    expect(() => new TenantPostgres({ connectionString: "mysql://localhost/db" })).toThrow("POSTGRES_URL_DENIED");
  });
});
