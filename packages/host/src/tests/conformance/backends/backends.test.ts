import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ReportKindCatalog } from "@aiengineer/knowledge-application";
import { FIXTURE_SEAL_KEYS } from "@aiengineer/knowledge-application/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKnowledgeOperationSurfaceFromEnv, defaultReportKindsDir } from "../../../knowledge-operation/config.js";
import { BACKEND as IN_MEMORY_BACKEND } from "../../../knowledge-operation/in-memory.js";
import { BackendRegistry, UnknownBinding } from "../../../knowledge-operation/registry.js";
import { type BackendConformance, defineBackendConformance } from "./suite.js";

/**
 * The host runs the backend conformance suite for the backend it owns (in-memory). The binding packages' registrations
 * run the same suite from the executable that composes them (apps/verification-executor
 * `src/knowledge-operation/backend-conformance.test.ts`), because the host imports no binding package.
 */
const KINDS = ReportKindCatalog.fromDirectory(resolve(defaultReportKindsDir()));

const IN_MEMORY_CONFORMANCE: BackendConformance = {
  registration: IN_MEMORY_BACKEND,
  openDisposable: async () => ({
    config: { application: "ai-engineer", binding: "in-memory", installationId: "conformance-in-memory" },
    // The fixture K07 seal key: the trusted assessment check seals through `report.seal` (WI-03).
    injection: { seal: FIXTURE_SEAL_KEYS },
    close: async () => undefined,
  }),
  exceptions: [],
};

defineBackendConformance({ describe, it, beforeAll, afterAll }, [IN_MEMORY_CONFORMANCE], { kinds: KINDS });

describe("backend registry", () => {
  it("resolves registered ids and refuses unknown or duplicate ones", () => {
    const registry = new BackendRegistry([IN_MEMORY_BACKEND]);
    expect(registry.ids()).toEqual(["in-memory"]);
    expect(registry.get("in-memory")).toBe(IN_MEMORY_BACKEND);
    expect(() => registry.get("no-such-binding")).toThrow(UnknownBinding);
    expect(() => new BackendRegistry([IN_MEMORY_BACKEND, IN_MEMORY_BACKEND])).toThrow(/DUPLICATE_BINDING/);
    const renamed = { ...IN_MEMORY_BACKEND, id: "renamed" };
    expect(() => new BackendRegistry([renamed])).toThrow(/BINDING_DESCRIPTOR_MISMATCH/);
  });
});

describe("env composition resolves bindings through the registry", () => {
  const directory = mkdtempSync(join(tmpdir(), "ks-backend-registry-"));
  const jwks = join(directory, "jwks.json");
  writeFileSync(jwks, JSON.stringify({ keys: [] }));
  const env = (bindings: unknown[]) => ({
    KS_KNOWLEDGE_ISSUER: "mission-control",
    KS_KNOWLEDGE_AUDIENCE: "knowledge-services-executor",
    KS_KNOWLEDGE_JWKS_FILE: jwks,
    KS_KNOWLEDGE_BINDINGS_JSON: JSON.stringify(bindings),
  });
  const registry = new BackendRegistry([IN_MEMORY_BACKEND]);

  it("creates each configured binding from its registration", async () => {
    const surface = await createKnowledgeOperationSurfaceFromEnv(
      env([{ application: "ai-engineer", binding: "in-memory", installationId: "i-1" }]),
      { registry },
    );
    try {
      expect(surface?.backends.map((backend) => [backend.binding, [...backend.capabilities].sort()])).toEqual([
        ["in-memory", ["native_receipt_lookup", "research"]],
      ]);
    } finally {
      await surface?.close();
    }
  });

  it("refuses a scripted auditor outside a disposable executor and advertises the auditor kind (WI-03 S7)", async () => {
    const script = join(directory, "auditor.json");
    writeFileSync(script, JSON.stringify({ entries: [] }));
    const bindings = [{ application: "ai-engineer", binding: "in-memory", installationId: "i-1" }];
    await expect(
      createKnowledgeOperationSurfaceFromEnv(
        { ...env(bindings), KS_KNOWLEDGE_AUDITOR_SCRIPT_FILE: script },
        { registry },
      ),
    ).rejects.toThrow(/KS_KNOWLEDGE_SCRIPTED_AUDITOR_REQUIRES_DISPOSABLE/);
    const disposable = await createKnowledgeOperationSurfaceFromEnv(
      { ...env(bindings), KS_KNOWLEDGE_AUDITOR_SCRIPT_FILE: script, KS_KNOWLEDGE_DISPOSABLE: "1" },
      { registry },
    );
    const plain = await createKnowledgeOperationSurfaceFromEnv(env(bindings), { registry });
    try {
      const [scripted] = disposable?.backends ?? [];
      const [none] = plain?.backends ?? [];
      expect(scripted && disposable?.service.descriptorFor(scripted).auditorKind).toBe("scripted");
      expect(none && plain?.service.descriptorFor(none).auditorKind).toBe("none");
    } finally {
      await disposable?.close();
      await plain?.close();
    }
  });

  it("refuses an executor without a use-class registry (WI-03 S9)", async () => {
    const authority = mkdtempSync(join(tmpdir(), "ks-authority-"));
    const rules = join(authority, "rules");
    mkdirSync(rules);
    await expect(
      createKnowledgeOperationSurfaceFromEnv(
        {
          ...env([{ application: "ai-engineer", binding: "in-memory", installationId: "i-1" }]),
          KS_KNOWLEDGE_SOURCE_AUTHORITY_DIR: rules,
        },
        { registry },
      ),
    ).rejects.toThrow(/KS_KNOWLEDGE_USE_CLASSES_REQUIRED/);
  });

  it("checks the AI Engineer database release once for a binding on its component login, and never for Biotech (VER-S1)", async () => {
    const dsn = "postgresql://component@127.0.0.1:1/unused";
    const asked: string[] = [];
    const report = {
      check: "enforce" as const,
      range: "0.12.0",
      release: "0.12.0",
      state: "current",
      verdict: "ok" as const,
      warning: false,
      reason: "the database is release 0.12.0",
      checkedAt: "2026-11-20T00:00:00.000Z",
    };
    const checkDatabaseRelease = async (connectionString: string) => {
      asked.push(connectionString);
      return report;
    };
    const aiEngineer = {
      application: "ai-engineer",
      binding: "in-memory",
      installationId: "i-1",
      databaseUrlEnv: "KS_AIENG_DB_COMPONENT_DSN",
    };
    const surface = await createKnowledgeOperationSurfaceFromEnv(
      { ...env([aiEngineer]), KS_AIENG_DB_COMPONENT_DSN: dsn },
      { registry, checkDatabaseRelease },
    );
    try {
      expect(asked).toEqual([dsn]);
      expect(surface?.databaseRelease).toEqual(report);
    } finally {
      await surface?.close();
    }
    // A refusal stops startup before any backend opens its store.
    await expect(
      createKnowledgeOperationSurfaceFromEnv(
        { ...env([aiEngineer]), KS_AIENG_DB_COMPONENT_DSN: dsn },
        {
          registry,
          checkDatabaseRelease: async () => {
            throw new Error("AIENG_DB_RELEASE_REFUSED: test");
          },
        },
      ),
    ).rejects.toThrow("AIENG_DB_RELEASE_REFUSED");
    // The Biotech plane, and a binding without a database, are never asked.
    asked.length = 0;
    const others = await createKnowledgeOperationSurfaceFromEnv(
      {
        ...env([
          {
            application: "biotech",
            binding: "in-memory",
            installationId: "i-2",
            databaseUrlEnv: "KS_BIOTECH_DB_COMPONENT_DSN",
          },
        ]),
        KS_BIOTECH_DB_COMPONENT_DSN: dsn,
      },
      { registry, checkDatabaseRelease },
    );
    try {
      expect(asked).toEqual([]);
      expect(others?.databaseRelease).toBeUndefined();
    } finally {
      await others?.close();
    }
  });

  it("refuses a binding no registration exports at startup", async () => {
    await expect(
      createKnowledgeOperationSurfaceFromEnv(
        env([{ application: "biotech", binding: "biotech-graph", installationId: "i-2" }]),
        { registry },
      ),
    ).rejects.toThrow(UnknownBinding);
  });
});
