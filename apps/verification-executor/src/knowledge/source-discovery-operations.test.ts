import { describe, expect, it } from "vitest";
import { knowledgeOperations } from "./operations.js";
import { loadKnowledgeConfig, type KnowledgeServices } from "./context.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const request = {
  schemaVersion: "source-discovery-managed-request.v1",
  providerCode: "tavily",
  queryText: "documentation",
  purpose: "research",
  parameters: {},
  requestedUrls: [],
  idempotencyKey: "source-one",
};
const services = { config: { defaultTenantId: tenantId } } as KnowledgeServices;

describe("source discovery public operation catalog", () => {
  it("uses the same operations for CLI, MCP and HTTP", () => {
    expect(knowledgeOperations.byCommand("source", "discover")).toBe(knowledgeOperations.get("source_discover"));
    expect(knowledgeOperations.byCommand("source", "import")).toBe(knowledgeOperations.get("source_import"));
    expect(knowledgeOperations.byCommand("source", "attempt")).toBe(knowledgeOperations.get("source_attempt"));
    expect(knowledgeOperations.byCommand("source", "reconcile")).toBe(knowledgeOperations.get("source_reconcile"));
  });

  it("does not silently downgrade configured remote custody to local storage", () => {
    expect(() => loadKnowledgeConfig({ KNOWLEDGE_ARTIFACT_STORAGE: "supabase" })).toThrow(
      "REMOTE_ARTIFACT_DATABASE_CONFIGURATION_REQUIRED",
    );
    expect(() =>
      loadKnowledgeConfig({
        KNOWLEDGE_ARTIFACT_STORAGE: "supabase",
        KNOWLEDGE_DB_URL: "postgresql://localhost:1/unused",
      }),
    ).toThrow("REMOTE_ARTIFACT_STORAGE_CONFIGURATION_REQUIRED");
    expect(loadKnowledgeConfig({})).toBeUndefined();
  });

  it("fails explicitly when durable storage is unavailable", async () => {
    await expect(knowledgeOperations.invoke("source_discover", { request }, services)).rejects.toThrow(
      "SOURCE_DISCOVERY_REMOTE_CUSTODY_REQUIRED",
    );
  });

  it("rejects a caller-selected foreign tenant before dispatch", async () => {
    await expect(
      knowledgeOperations.invoke(
        "source_discover",
        { request, tenantId: "22222222-2222-4222-8222-222222222222" },
        services,
      ),
    ).rejects.toThrow("EVIDENCE_NOT_AUTHORIZED");
  });
});
