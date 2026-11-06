import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pools = vi.hoisted(() => ({ created: 0, ended: 0 }));

// Observe pool ownership at the persistence boundary host composes. Pools connect
// lazily, so constructing and ending them needs no database.
vi.mock("@aiengineer/knowledge-persistence", async (importOriginal) => {
  const original = await importOriginal<typeof import("@aiengineer/knowledge-persistence")>();
  class PostgresCanonicalRepository extends original.PostgresCanonicalRepository {
    constructor(...parameters: ConstructorParameters<typeof original.PostgresCanonicalRepository>) {
      super(...parameters);
      pools.created += 1;
    }
    override async close() {
      pools.ended += 1;
      await super.close();
    }
  }
  return {
    ...original,
    PostgresCanonicalRepository,
    createCanonicalPersistence: (...parameters: Parameters<typeof original.createCanonicalPersistence>) => {
      const persistence = original.createCanonicalPersistence(...parameters);
      pools.created += 1;
      return {
        ...persistence,
        close: async () => {
          pools.ended += 1;
          await persistence.close();
        },
      };
    },
  };
});

const database = { POSTGRES_URL: "postgres://user:secret@127.0.0.1:54322/knowledge", CANONICAL_LOCAL_ONLY: "1" };
const noPublicOrigin = () => undefined;

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  pools.created = 0;
  pools.ended = 0;
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("NETWORK_NOT_ALLOWED"));
});
afterEach(() => {
  fetchSpy.mockRestore();
});

describe("host import and profile admission", () => {
  it("opens no pool, timer or network connection on import", async () => {
    vi.useFakeTimers();
    try {
      const host = await import("../index.js");
      expect(typeof host.createHost).toBe("function");
      expect(pools.created).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("composes the local profile lazily without reaching the network or a database", async () => {
    const { createHost } = await import("../index.js");
    const create = vi.fn();
    const host = await createHost({
      profile: "local",
      storeDir: "never-created-store",
      verification: { captureMediaKind: vi.fn(), create: create as never },
    });
    expect(host.profile).toBe("local");
    expect(host.capabilities).toEqual({
      onlineCapture: false,
      documentConversion: false,
      database: false,
    });
    await host.close();
    expect(create).not.toHaveBeenCalled();
    expect(pools.created).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a profile it does not compose explicitly without reaching the network or a database", async () => {
    const { createHost, HostProfileUnavailableError } = await import("../index.js");
    const failure = await createHost({ profile: "remote-cli" } as never).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(HostProfileUnavailableError);
    expect(failure).toMatchObject({ code: "HOST_PROFILE_UNAVAILABLE", profile: "remote-cli" });
    expect(pools.created).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("API host composition", () => {
  it("exposes no persistence-backed capability when none is configured", async () => {
    const { createHost } = await import("../index.js");
    const host = await createHost({
      profile: "server",
      role: "api",
      resolvePublicOrigin: noPublicOrigin,
      environment: { NODE_ENV: "test" },
    });
    expect(host.capabilities).toEqual({
      persistence: false,
      retrieval: false,
      citationReplay: false,
      verification: false,
    });
    expect(host.operations).toBeUndefined();
    expect(host.knowledge).toEqual({});
    expect(Object.keys(host.verify)).toEqual(["runtime"]);
    await host.close();
    expect(pools.created).toBe(0);
  });

  it("validates the public origin before opening the pool", async () => {
    const { createHost } = await import("../index.js");
    await expect(
      createHost({
        profile: "server",
        role: "api",
        environment: { NODE_ENV: "test", ...database },
        resolvePublicOrigin: () => {
          throw new Error("INVALID_KNOWLEDGE_API_URL");
        },
      }),
    ).rejects.toThrow("INVALID_KNOWLEDGE_API_URL");
    expect(pools.created).toBe(0);
  });

  it("releases the pool when construction fails after it opened", async () => {
    const { createHost } = await import("../index.js");
    await expect(
      createHost({
        profile: "server",
        role: "api",
        resolvePublicOrigin: noPublicOrigin,
        environment: { NODE_ENV: "test", ...database, VERIFICATION_DRIFT_REVALIDATION_ENABLED: "1" },
      }),
    ).rejects.toThrow("VERIFICATION_RETIRED_CONFIGURATION:VERIFICATION_DRIFT_REVALIDATION_ENABLED");
    await expect(
      createHost({
        profile: "server",
        role: "api",
        resolvePublicOrigin: noPublicOrigin,
        environment: { NODE_ENV: "test", ...database, VERIFICATION_BENCHMARK_CAPTURE_PROFILES_JSON: "[]" },
      }),
    ).rejects.toThrow("VERIFICATION_BENCHMARK_CAPTURE_PROFILE_CONFIGURATION_REQUIRED");
    expect(pools).toEqual({ created: 2, ended: 2 });
  });

  it("composes durable ports with persistence and releases the pool exactly once", async () => {
    const { createHost } = await import("../index.js");
    const host = await createHost({
      profile: "server",
      role: "api",
      resolvePublicOrigin: noPublicOrigin,
      environment: { NODE_ENV: "test", ...database },
    });
    expect(host.capabilities).toMatchObject({ persistence: true, retrieval: false });
    expect(host.operations).toBeDefined();
    expect(host.knowledge.resources).toBeDefined();
    expect(host.knowledge.canonicalRetrievalExecutor).toBeUndefined();
    await Promise.all([host.close(), host.close()]);
    await host.close();
    expect(pools).toEqual({ created: 1, ended: 1 });
  });
});

describe("MCP host composition", () => {
  it("requires persistence and validates the API origin before opening the pool", async () => {
    const { createHost } = await import("../index.js");
    const resolveApiOrigin = () => "http://127.0.0.1:4100";
    await expect(
      createHost({ profile: "server", role: "mcp", environment: { NODE_ENV: "test" }, resolveApiOrigin }),
    ).rejects.toThrow("POSTGRES_URL_REQUIRED");
    await expect(
      createHost({
        profile: "server",
        role: "mcp",
        environment: { NODE_ENV: "test", ...database },
        resolveApiOrigin: () => {
          throw new Error("KNOWLEDGE_API_URL_REQUIRED");
        },
      }),
    ).rejects.toThrow("KNOWLEDGE_API_URL_REQUIRED");
    expect(pools.created).toBe(0);
    const host = await createHost({
      profile: "server",
      role: "mcp",
      environment: { NODE_ENV: "test", ...database },
      resolveApiOrigin,
    });
    expect(host.config.PORT).toBe(4101);
    expect(host.verify.operations).toBeUndefined();
    await host.close();
    expect(pools).toEqual({ created: 1, ended: 1 });
  });

  it("composes the API role's knowledge and verification groups without transport-only pieces", async () => {
    const { createHost } = await import("../index.js");
    const environment = { NODE_ENV: "test", ...database };
    const api = await createHost({ profile: "server", role: "api", resolvePublicOrigin: noPublicOrigin, environment });
    const mcp = await createHost({
      profile: "server",
      role: "mcp",
      environment,
      resolveApiOrigin: () => "http://127.0.0.1:4100",
    });
    try {
      expect(Object.keys(mcp.knowledge).sort()).toEqual(Object.keys(api.knowledge).sort());
      expect(Object.keys(mcp.verify).sort()).toEqual(Object.keys(api.verify).sort());
      expect(Object.keys(mcp.operations).sort()).toEqual(["retrieval", "service"]);
      expect(mcp).not.toHaveProperty("publicOrigin");
      expect(mcp.verify).not.toHaveProperty("driftRevalidation");
    } finally {
      await Promise.all([api.close(), mcp.close()]);
    }
    expect(pools).toEqual({ created: 2, ended: 2 });
  });

  it("applies the API role's verification use-case configuration failures", async () => {
    const { createHost } = await import("../index.js");
    for (const [setting, failure] of [
      [
        { VERIFICATION_BENCHMARK_CAPTURE_PROFILES_JSON: "[]" },
        "VERIFICATION_BENCHMARK_CAPTURE_PROFILE_CONFIGURATION_REQUIRED",
      ],
      [
        { VERIFICATION_ADJUDICATION_DECISIONS_ENABLED: "yes" },
        "VERIFICATION_RETIRED_CONFIGURATION:VERIFICATION_ADJUDICATION_DECISIONS_ENABLED",
      ],
    ] as const)
      await expect(
        createHost({
          profile: "server",
          role: "mcp",
          environment: { NODE_ENV: "test", ...database, ...setting },
          resolveApiOrigin: () => "http://127.0.0.1:4100",
        }),
      ).rejects.toThrow(failure);
    expect(pools).toEqual({ created: 2, ended: 2 });
  });

  it("releases the pool when shared verification admission rejects its configuration", async () => {
    const { createHost } = await import("../index.js");
    await expect(
      createHost({
        profile: "server",
        role: "mcp",
        environment: { NODE_ENV: "test", ...database, VERIFICATION_METRIC_ENABLED: "1" },
        resolveApiOrigin: () => "http://127.0.0.1:4100",
      }),
    ).rejects.toThrow("VERIFICATION_RETIRED_CONFIGURATION:VERIFICATION_METRIC_ENABLED");
    expect(pools).toEqual({ created: 1, ended: 1 });
  });
});

describe("worker host composition", () => {
  const postgresWorker = {
    NODE_ENV: "test",
    ...database,
    WORKER_TENANT_ID: "00000000-0000-4000-8000-000000000001",
    SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_SECRET_KEY: "test-secret-key",
  };
  const execution = (overrides: { reconcile?: () => Promise<number>; build?: () => void } = {}) => {
    const phases: string[] = [];
    return {
      phases,
      factory: () => {
        phases.push("prepare");
        return (adapters: { mode: string }) => {
          phases.push(`build:${adapters.mode}`);
          overrides.build?.();
          return {
            registeredActivities: ["test_activity"],
            reconcile: overrides.reconcile ?? (async () => 3),
            runOnce: async () => undefined,
          };
        };
      },
    };
  };

  it("keeps memory mode development/test-only and never opens a pool for it", async () => {
    const { createHost } = await import("../index.js");
    const production = execution();
    await expect(
      createHost({
        profile: "server",
        role: "worker",
        environment: { KNOWLEDGE_PERSISTENCE_MODE: "memory", NODE_ENV: "production" },
        execution: production.factory,
      }),
    ).rejects.toThrow("IN_MEMORY_PERSISTENCE_NOT_ADMITTED");
    expect(production.phases).toEqual([]);
    const memory = execution();
    const host = await createHost({
      profile: "server",
      role: "worker",
      environment: { KNOWLEDGE_PERSISTENCE_MODE: "memory", NODE_ENV: "test", WORKER_ID: "memory-worker" },
      execution: memory.factory,
    });
    expect(memory.phases).toEqual(["prepare", "build:memory"]);
    expect(host).toMatchObject({
      mode: "memory",
      owner: "memory-worker",
      reconciled: 3,
      registeredActivities: ["test_activity"],
    });
    await host.close();
    expect(pools.created).toBe(0);
  });

  it("validates tenant scope before opening persistence", async () => {
    const { createHost } = await import("../index.js");
    const { factory } = execution();
    await expect(
      createHost({
        profile: "server",
        role: "worker",
        environment: { ...postgresWorker, WORKER_TENANT_ID: "" },
        execution: factory,
      }),
    ).rejects.toThrow("WORKER_TENANT_ID_REQUIRED");
    expect(pools.created).toBe(0);
  });

  it("releases persistence when adapter, execution or reconciliation construction fails", async () => {
    const { createHost } = await import("../index.js");
    await expect(
      createHost({
        profile: "server",
        role: "worker",
        environment: { ...postgresWorker, ACQUISITION_TIMEOUT_MS: "0" },
        execution: execution().factory,
      }),
    ).rejects.toThrow("INVALID_ACQUISITION_TIMEOUT_MS");
    await expect(
      createHost({
        profile: "server",
        role: "worker",
        environment: postgresWorker,
        execution: execution({
          build: () => {
            throw new Error("VERIFICATION_SERVICE_CATALOG_INVALID");
          },
        }).factory,
      }),
    ).rejects.toThrow("VERIFICATION_SERVICE_CATALOG_INVALID");
    await expect(
      createHost({
        profile: "server",
        role: "worker",
        environment: postgresWorker,
        execution: execution({ reconcile: () => Promise.reject(new Error("RECONCILIATION_FAILED")) }).factory,
      }),
    ).rejects.toThrow("RECONCILIATION_FAILED");
    expect(pools).toEqual({ created: 3, ended: 3 });
  });

  it("reconciles before returning and releases persistence once", async () => {
    const { createHost } = await import("../index.js");
    const { factory, phases } = execution();
    const host = await createHost({
      profile: "server",
      role: "worker",
      environment: postgresWorker,
      execution: factory,
    });
    expect(phases).toEqual(["prepare", "build:postgres"]);
    expect(host.reconciled).toBe(3);
    await Promise.all([host.close(), host.close()]);
    expect(pools).toEqual({ created: 1, ended: 1 });
  });
});
