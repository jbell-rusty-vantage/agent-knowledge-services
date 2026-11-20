import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pools = vi.hoisted(() => ({ created: 0, ended: 0 }));
/**
 * What the database behind the double answers for `api.database_release()`: `undefined` is the release this service
 * was built for, as stamped; `null` is a database without the function; an `Error` is one that cannot be asked.
 */
const release = vi.hoisted(() => ({ answer: undefined as unknown, asked: 0 }));

// Observe pool ownership at the persistence boundary host composes. Pools connect
// lazily, so constructing and ending them needs no database; the release probe is
// answered here, so no test reaches one either.
vi.mock("@aiengineer/knowledge-persistence", async (importOriginal) => {
  const original = await importOriginal<typeof import("@aiengineer/knowledge-persistence")>();
  const databaseRelease = async (): Promise<unknown> => {
    release.asked += 1;
    if (release.answer instanceof Error) throw release.answer;
    return release.answer === undefined
      ? { format: original.DATABASE_RELEASE_FORMAT, release: original.serviceReleaseRange(), state: "current" }
      : release.answer;
  };
  class PostgresCanonicalRepository extends original.PostgresCanonicalRepository {
    constructor(...parameters: ConstructorParameters<typeof original.PostgresCanonicalRepository>) {
      super(...parameters);
      pools.created += 1;
    }
    override async close() {
      pools.ended += 1;
      await super.close();
    }
    override databaseRelease() {
      return databaseRelease();
    }
  }
  return {
    ...original,
    PostgresCanonicalRepository,
    createCanonicalPersistence: (...parameters: Parameters<typeof original.createCanonicalPersistence>) => {
      const persistence = original.createCanonicalPersistence(...parameters);
      Object.assign(persistence.database, { databaseRelease });
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

const database = {
  KS_AIENG_DB_RUNTIME_DSN: "postgres://user:secret@127.0.0.1:54322/knowledge",
  CANONICAL_LOCAL_ONLY: "1",
};
const noPublicOrigin = () => undefined;

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  pools.created = 0;
  pools.ended = 0;
  release.answer = undefined;
  release.asked = 0;
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
    ).rejects.toThrow("KS_AIENG_DB_RUNTIME_DSN_REQUIRED");
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
    KS_AIENG_DB_URL: "http://127.0.0.1:54321",
    KS_AIENG_DB_SECRET_KEY: "test-secret-key",
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

describe("AI Engineer database release at startup (VER-S1)", () => {
  const stated = (release: string | null, state: string) => ({
    format: "ai-engineer-database-release/1",
    release,
    state,
  });
  const api = (environment: Record<string, string>) =>
    import("../index.js").then(({ createHost }) =>
      createHost({ profile: "server", role: "api", resolvePublicOrigin: noPublicOrigin, environment }),
    );
  const mcp = (environment: Record<string, string>) =>
    import("../index.js").then(({ createHost }) =>
      createHost({
        profile: "server",
        role: "mcp",
        environment,
        resolveApiOrigin: () => "http://127.0.0.1:4100",
      }),
    );
  const worker = (environment: Record<string, string>, phases: string[] = []) =>
    import("../index.js").then(({ createHost }) =>
      createHost({
        profile: "server",
        role: "worker",
        environment: {
          ...environment,
          WORKER_TENANT_ID: "00000000-0000-4000-8000-000000000001",
          KS_AIENG_DB_URL: "http://127.0.0.1:54321",
          KS_AIENG_DB_SECRET_KEY: "test-secret-key",
        },
        execution: () => {
          phases.push("prepare");
          return () => {
            phases.push("build");
            return {
              registeredActivities: [],
              reconcile: async () => {
                phases.push("reconcile");
                return 0;
              },
              runOnce: async () => undefined,
            };
          };
        },
      }),
    );
  const test = { NODE_ENV: "test", ...database };

  it("starts every role on the release this service was built for and reports release, state, range and verdict", async () => {
    const { serviceReleaseRange } = await import("@aiengineer/knowledge-persistence");
    const range = serviceReleaseRange();
    const hosts = [await api(test), await mcp(test), await worker(test)];
    try {
      for (const host of hosts)
        expect(host.databaseRelease).toMatchObject({
          check: "enforce",
          range,
          release: range,
          state: "current",
          verdict: "ok",
          warning: false,
        });
    } finally {
      await Promise.all(hosts.map((host) => host.close()));
    }
    expect(pools).toEqual({ created: 3, ended: 3 });
    expect(release.asked).toBe(3);
  });

  it("refuses to start the API on an incompatible release, with one error naming release, range, state and the variable", async () => {
    const { serviceReleaseRange } = await import("@aiengineer/knowledge-persistence");
    release.answer = stated("0.0.1", "current");
    const refused = await api(test).catch((error: unknown) => error);
    expect(refused).toMatchObject({
      name: "DatabaseReleaseRefused",
      code: "AIENG_DB_RELEASE_REFUSED",
      report: { verdict: "incompatible", release: "0.0.1", state: "current", range: serviceReleaseRange() },
    });
    const message = (refused as Error).message;
    expect(message).toContain("Database release: 0.0.1; state: current;");
    expect(message).toContain(`this service works with: ${serviceReleaseRange()}.`);
    expect(message).toContain("AIENG_DB_RELEASE_CHECK=warn");
    expect(message).toContain("AIENG_DB_RELEASE_CHECK=off");
    // The pool that was opened to ask is released again.
    expect(pools).toEqual({ created: 1, ended: 1 });
    expect(release.asked).toBe(1);
  });

  it("refuses MCP on a database that states no release and the worker before it builds or reconciles anything", async () => {
    release.answer = null;
    await expect(mcp(test)).rejects.toMatchObject({ report: { verdict: "unknown", release: null } });
    release.answer = stated(null, "unstamped");
    await expect(mcp(test)).rejects.toMatchObject({ report: { verdict: "unstamped" } });
    release.answer = new Error("connect ECONNREFUSED 127.0.0.1:54322");
    await expect(mcp(test)).rejects.toThrow(
      "the database could not be asked for its release (connect ECONNREFUSED 127.0.0.1:54322)",
    );
    const { serviceReleaseRange } = await import("@aiengineer/knowledge-persistence");
    release.answer = stated(serviceReleaseRange(), "inconsistent");
    const phases: string[] = [];
    await expect(worker(test, phases)).rejects.toMatchObject({ report: { verdict: "inconsistent" } });
    expect(phases).toEqual(["prepare"]);
    expect(pools).toEqual({ created: 4, ended: 4 });
  });

  it("starts with a warning on a release that is in range but ahead of its stamp", async () => {
    const { serviceReleaseRange } = await import("@aiengineer/knowledge-persistence");
    release.answer = stated(serviceReleaseRange(), "ahead");
    const host = await api(test);
    expect(host.databaseRelease).toMatchObject({ verdict: "ok", warning: true, state: "ahead" });
    await host.close();
  });

  it("warn mode starts on any verdict and logs it; off mode does not ask the database", async () => {
    release.answer = stated("0.0.1", "current");
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const warned = await api({ ...database, NODE_ENV: "development", AIENG_DB_RELEASE_CHECK: "warn" });
      expect(warned.databaseRelease).toMatchObject({ check: "warn", verdict: "incompatible", release: "0.0.1" });
      await warned.close();
      const lines = stderr.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.includes("ks.database.release"));
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
        event: "ks.database.release",
        check: "warn",
        verdict: "incompatible",
        release: "0.0.1",
        state: "current",
      });
      expect(lines[0]).not.toContain("secret");
    } finally {
      stderr.mockRestore();
    }
    release.asked = 0;
    const phases: string[] = [];
    const off = await worker({ ...test, AIENG_DB_RELEASE_CHECK: "off" }, phases);
    expect(off.databaseRelease).toMatchObject({ check: "off", verdict: "not_checked", release: null, state: null });
    expect(phases).toEqual(["prepare", "build", "reconcile"]);
    await off.close();
    expect(release.asked).toBe(0);
    await expect(api({ ...test, AIENG_DB_RELEASE_CHECK: "sometimes" })).rejects.toThrow(
      "AIENG_DB_RELEASE_CHECK must be enforce, warn or off (got sometimes)",
    );
  });

  it("never asks a Biotech database for an AI Engineer release", async () => {
    release.answer = stated("0.0.1", "current");
    const host = await api({
      NODE_ENV: "test",
      KS_APPLICATION: "biotech",
      KS_BIOTECH_DB_RUNTIME_DSN: database.KS_AIENG_DB_RUNTIME_DSN,
      CANONICAL_LOCAL_ONLY: "1",
    });
    expect(host.capabilities.persistence).toBe(true);
    expect(host.databaseRelease).toBeUndefined();
    await host.close();
    expect(pools).toEqual({ created: 1, ended: 1 });
    expect(release.asked).toBe(0);
  });

  it("asks nothing when a process has no persistence", async () => {
    const host = await api({ NODE_ENV: "test" });
    expect(host.databaseRelease).toBeUndefined();
    await host.close();
    expect(release.asked).toBe(0);
  });
});
