import type { KnowledgeApplyPort } from "@aiengineer/knowledge-host/knowledge-operation";
import { describe, expect, it } from "vitest";
import { BACKEND, createAiEngineerPostgresBackend } from "./backend.js";
import { INGESTION_APPLY_CONTRACT } from "./ingestion-apply.js";

/** No database: the contract check refuses before any connection is opened. */
const OTHER_CONTRACT: KnowledgeApplyPort = {
  nativeContract: { name: "biotech-knowledge-apply", version: "v1" },
  apply: async () => {
    throw new Error("never called");
  },
};

describe("aiengineer-postgres BACKEND", () => {
  it("declares apply only as conditional on an injected apply port, with the ingestion contract", () => {
    const descriptor = BACKEND.describe();
    expect(descriptor.capabilities).not.toContain("apply");
    expect(descriptor.conditionalCapabilities).toEqual([
      { capability: "apply", condition: "host_injected_apply_port" },
      { capability: "read_intent", condition: "host_injected_read_intent_port" },
    ]);
    expect(descriptor.nativeContract).toEqual(INGESTION_APPLY_CONTRACT);
  });

  it("refuses an injected apply port that names another native contract", async () => {
    await expect(
      createAiEngineerPostgresBackend({
        application: "ai-engineer",
        binding: "aiengineer-postgres",
        installationId: "00000000-0000-7000-8000-000000000001",
        connectionString: "postgresql://unused@127.0.0.1:1/unused",
        kinds: {} as never,
        auditor: null,
        apply: OTHER_CONTRACT,
      }),
    ).rejects.toThrow(/BACKEND_APPLY_CONTRACT_MISMATCH/);
    await expect(
      BACKEND.create(
        {
          application: "ai-engineer",
          binding: "aiengineer-postgres",
          installationId: "00000000-0000-7000-8000-000000000001",
          databaseUrlEnv: "KS_UNUSED_DSN",
        },
        {
          kinds: {} as never,
          auditor: null,
          seal: null,
          apply: OTHER_CONTRACT,
          env: { KS_UNUSED_DSN: "postgresql://unused@127.0.0.1:1/unused" },
        },
      ),
    ).rejects.toThrow(/BACKEND_APPLY_CONTRACT_MISMATCH/);
  });

  it("refuses a configuration without a database", async () => {
    await expect(
      BACKEND.create(
        { application: "ai-engineer", binding: "aiengineer-postgres", installationId: "i" },
        { kinds: {} as never, auditor: null, seal: null, apply: null, env: {} },
      ),
    ).rejects.toThrow(/KNOWLEDGE_BINDING_DATABASE_REQUIRED/);
  });
});
