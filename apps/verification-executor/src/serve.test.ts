import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadExecutorConfig, VerificationExecutor } from "./executor.js";
import { createKnowledgeFromEnv } from "./serve.js";

describe("local knowledge host composition", () => {
  it("keeps verification-only hosts available without a database", async () => {
    expect(await createKnowledgeFromEnv({})).toBeUndefined();
  });

  it("composes the exact-use admission oracle and the K08 use classes for the same default tenant", async () => {
    const root = await mkdtemp(join(tmpdir(), "ks-host-composition-"));
    const env = {
      KNOWLEDGE_DB_URL: "postgresql://localhost:1/unused",
      SCHEMA_WORKSPACE_DIR: fileURLToPath(
        new URL("../../../../../aiengineer/ai-engineer-db-contract/workspace", import.meta.url),
      ),
      KNOWLEDGE_ARTIFACT_DIR: join(root, "artifacts"),
      VERIFY_STORE_DIR: join(root, "verification"),
    };
    const services = await createKnowledgeFromEnv(env);
    try {
      expect(services?.config.defaultTenantId).toBe(loadExecutorConfig(env).tenantId);
      expect(services?.useClasses.registry.id).toBe("use-classes");
    } finally {
      await services?.close();
    }
    const executor = await VerificationExecutor.create(loadExecutorConfig(env));
    const reused = await createKnowledgeFromEnv(env, executor);
    await reused?.close();
    await expect(
      createKnowledgeFromEnv({ ...env, KNOWLEDGE_TENANT_ID: "00000000-0000-4000-8000-000000000099" }, executor),
    ).rejects.toThrow("KNOWLEDGE_TENANT_MISMATCH");
    // SV-17: the executor-hosted evidence oracle is retired; its configuration is refused, never ignored.
    await expect(createKnowledgeFromEnv({ ...env, KNOWLEDGE_EVIDENCE_ORACLE: "declared" }, executor)).rejects.toThrow(
      "EXECUTOR_RETIRED_CONFIGURATION:KNOWLEDGE_EVIDENCE_ORACLE",
    );
    for (const name of ["KNOWLEDGE_EVIDENCE_POLICY_VERSION", "KNOWLEDGE_RECOVERY_CONFIG_JSON", "VERIFY_JUDGE_MODEL"])
      await expect(createKnowledgeFromEnv({ ...env, [name]: "x" }, executor)).rejects.toThrow(
        `EXECUTOR_RETIRED_CONFIGURATION:${name}`,
      );
  });
});
