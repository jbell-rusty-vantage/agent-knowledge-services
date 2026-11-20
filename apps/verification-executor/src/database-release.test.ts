import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What the database behind the double answers for `api.database_release()`: `undefined` is the release this service
 * was built for, as stamped. The executor's pool (`TenantPostgres`) is the persistence boundary it composes, so the
 * double sits there and no test reaches a database.
 */
const release = vi.hoisted(() => ({ answer: undefined as unknown, asked: 0, closed: 0 }));

vi.mock("@aiengineer/knowledge-persistence", async (importOriginal) => {
  const original = await importOriginal<typeof import("@aiengineer/knowledge-persistence")>();
  class TenantPostgres extends original.TenantPostgres {
    override async databaseRelease(): Promise<unknown> {
      release.asked += 1;
      return release.answer === undefined
        ? { format: original.DATABASE_RELEASE_FORMAT, release: original.serviceReleaseRange(), state: "current" }
        : release.answer;
    }
    override async migrationHead(): Promise<string | undefined> {
      return original.pinnedContractRelease().migrationHead.split("_")[0];
    }
    override async close(): Promise<void> {
      release.closed += 1;
      await super.close();
    }
  }
  return { ...original, TenantPostgres };
});

const { serviceReleaseRange } = await import("@aiengineer/knowledge-persistence");
const { createKnowledgeFromEnv, describeRunning, startExecutorServer } = await import("./serve.js");
const { createScopedCustodyHost } = await import("./scoped-host.js");

const stated = (version: string | null, state: string) => ({
  format: "ai-engineer-database-release/1",
  release: version,
  state,
});

async function environment(extra: Record<string, string> = {}): Promise<Record<string, string>> {
  const root = await mkdtemp(join(tmpdir(), "ks-executor-release-"));
  return {
    NODE_ENV: "test",
    KS_AIENG_DB_RUNTIME_DSN: "postgresql://localhost:1/unused",
    KNOWLEDGE_ARTIFACT_DIR: join(root, "artifacts"),
    VERIFY_STORE_DIR: join(root, "verification"),
    ...extra,
  };
}

beforeEach(() => {
  release.answer = undefined;
  release.asked = 0;
  release.closed = 0;
});

describe("the executor checks the AI Engineer database release before it serves (VER-S1)", () => {
  it("opens the knowledge services on the release it was built for and reports it", async () => {
    const services = await createKnowledgeFromEnv(await environment());
    try {
      expect(services?.databaseRelease).toMatchObject({
        check: "enforce",
        range: serviceReleaseRange(),
        release: serviceReleaseRange(),
        state: "current",
        verdict: "ok",
        warning: false,
      });
      expect(release.asked).toBe(1);
    } finally {
      await services?.close();
    }
  });

  it("refuses the knowledge CLI, mcp-stdio and serve on an incompatible release and closes the pool it opened", async () => {
    release.answer = stated("0.0.1", "current");
    const env = await environment();
    const refused = await createKnowledgeFromEnv(env).catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: "AIENG_DB_RELEASE_REFUSED", report: { verdict: "incompatible" } });
    expect((refused as Error).message).toContain("Database release: 0.0.1; state: current;");
    expect((refused as Error).message).toContain(`this service works with: ${serviceReleaseRange()}.`);
    expect((refused as Error).message).toContain("AIENG_DB_RELEASE_CHECK=warn");
    expect(release.closed).toBe(1);

    release.closed = 0;
    await expect(startExecutorServer({ port: 0, host: "127.0.0.1", env })).rejects.toThrow("AIENG_DB_RELEASE_REFUSED");
    expect(release.closed).toBe(1);

    release.answer = null;
    await expect(createKnowledgeFromEnv(env)).rejects.toMatchObject({ report: { verdict: "unknown" } });
  });

  it("starts in warn mode on any verdict and does not ask in off mode", async () => {
    release.answer = stated("0.0.1", "current");
    const warned = await createKnowledgeFromEnv(await environment({ AIENG_DB_RELEASE_CHECK: "warn" }));
    expect(warned?.databaseRelease).toMatchObject({ check: "warn", verdict: "incompatible", release: "0.0.1" });
    await warned?.close();
    release.asked = 0;
    const off = await createKnowledgeFromEnv(await environment({ AIENG_DB_RELEASE_CHECK: "off" }));
    expect(off?.databaseRelease).toMatchObject({ check: "off", verdict: "not_checked" });
    await off?.close();
    expect(release.asked).toBe(0);
  });

  it("states the release on /health and in the startup description, without the free-text reason on /health", async () => {
    release.answer = stated(serviceReleaseRange(), "ahead");
    const running = await startExecutorServer({ port: 0, host: "127.0.0.1", env: await environment() });
    try {
      const health = (await (await fetch(`${running.url}/health`)).json()) as {
        knowledge: { databaseRelease: Record<string, unknown> };
      };
      expect(health.knowledge.databaseRelease).toMatchObject({
        check: "enforce",
        range: serviceReleaseRange(),
        release: serviceReleaseRange(),
        state: "ahead",
        verdict: "ok",
        warning: true,
      });
      expect(health.knowledge.databaseRelease).not.toHaveProperty("reason");
      const described = describeRunning(running, "none") as { knowledge: { databaseRelease: { reason: string } } };
      expect(described.knowledge.databaseRelease.reason).toContain("migrations were applied after the stamp");
    } finally {
      await running.close();
    }
  });

  it("refuses the scoped custody host on an incompatible release", async () => {
    release.answer = stated("0.0.1", "current");
    const tenant = "7f3e2d1c-0b9a-4876-9543-210fedcba987";
    const attempt = "11111111-1111-4111-8111-111111111111";
    await expect(
      createScopedCustodyHost({
        env: {
          ...(await environment()),
          KNOWLEDGE_ARTIFACT_STORAGE: "supabase",
          KS_AIENG_DB_URL: "http://127.0.0.1:1",
          KS_AIENG_DB_SECRET_KEY: "unused",
          VERIFY_TENANT_ID: tenant,
          KNOWLEDGE_TENANT_ID: tenant,
          VERIFY_PRODUCER_ATTEMPT_ID: attempt,
          VERIFY_VERIFIER_ATTEMPT_ID: "22222222-2222-4222-8222-222222222222",
          KNOWLEDGE_PRODUCER_ATTEMPT_ID: attempt,
        },
      }),
    ).rejects.toThrow("AIENG_DB_RELEASE_REFUSED");
  });
});
