import type { ResourceReadRepository } from "@aiengineer/knowledge-persistence";
import { describe, expect, it, vi } from "vitest";
import type { LocalApiIdentity } from "@aiengineer/knowledge-host/config";
import { buildServer } from "../server.js";

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const tenantId = id(1);
const token = "resource-reader-test-token";
const identity: LocalApiIdentity = {
  actor: {
    kind: "service",
    id: id(2),
    serviceIdentity: "mission_control_client",
  },
  grants: [{ tenantId, roles: ["knowledge_reader"], scopes: [] }],
};
const headers = {
  authorization: `Bearer ${token}`,
  "x-tenant-id": tenantId,
  "x-correlation-id": "resource-read-correlation",
};

function reader(): ResourceReadRepository {
  return {
    getVectorStoreResource: vi.fn(async (tenant, vectorStoreId) =>
      tenant === tenantId && vectorStoreId === id(9)
        ? {
            id: vectorStoreId,
            tenantId: tenant,
            ownerIdentity: "service:test",
            storeClass: "internal_exploratory" as const,
            slug: "test-store",
            name: "Test store",
            purpose: "testing",
            visibility: "tenant" as const,
            lifecycle: "active" as const,
            quotaProfile: {},
            retentionPolicy: {},
            deletionPolicy: {},
            createdAt: "2026-09-04T00:00:00.000Z",
            documentCount: 3,
            spaces: [],
            spacesTruncated: false,
          }
        : undefined,
    ),
    getArtifactResource: vi.fn(async (tenant, artifactId) =>
      tenant === tenantId && artifactId === id(10)
        ? {
            artifactId,
            tenantId: tenant,
            artifactType: "source_capture",
            schemaVersion: 1,
            digest: `sha256:${"a".repeat(64)}`,
            bucketClass: "raw",
            mediaType: "text/plain",
            byteLength: 12,
            createdAt: "2026-09-04T00:00:00.000Z",
          }
        : undefined,
    ),
    getReceiptResource: vi.fn(async (tenant, receiptId) =>
      tenant === tenantId && receiptId === id(11)
        ? {
            id: receiptId,
            tenantId: tenant,
            operationId: id(12),
            stepId: id(13),
            receiptKind: "retrieve.succeeded",
            idempotencyKey: "receipt-key",
            executorIdentity: "worker:test",
            inputSha256: "b".repeat(64),
            inputDigest: `sha256:${"b".repeat(64)}`,
            outputSha256: "c".repeat(64),
            outputDigest: `sha256:${"c".repeat(64)}`,
            outcome: "succeeded",
            body: { packetId: id(14) },
            createdAt: "2026-09-04T00:00:01.000Z",
          }
        : undefined,
    ),
    getRetrievalRunResource: vi.fn(async (tenant, runId) =>
      tenant === tenantId && runId === id(20)
        ? {
            id: runId,
            tenantId: tenant,
            plan: {
              id: id(21),
              queryIntent: "durable retrieval",
              decomposition: [],
              spaces: ["engineering_claims"],
              filters: {},
              policyVersion: 1,
              validated: true,
              createdAt: "2026-09-04T00:00:00.000Z",
            },
            stageTimings: { lexicalMs: 1 },
            fusionParameters: { rrfK: 60 },
            executedAt: "2026-09-04T00:00:02.000Z",
            evidencePacketIds: [id(22)],
          }
        : undefined,
    ),
    getRetrievalExplanationResource: vi.fn(async (tenant, runId) =>
      tenant === tenantId && runId === id(20)
        ? {
            retrievalRunId: runId,
            stageTimings: { lexicalMs: 1 },
            fusionParameters: { rrfK: 60 },
            candidates: [
              {
                id: id(23),
                stageScores: { lexical: 0.8 },
                rank: 1,
                finalScore: 0.75,
                sources: [
                  {
                    channel: "lexical",
                    sourceRank: 1,
                    score: 0.8,
                    explanation: { match: "exact" },
                  },
                ],
              },
            ],
            truncated: false,
          }
        : undefined,
    ),
    getEvaluationReportResource: vi.fn(async () => undefined),
    getEvaluationFailuresResource: vi.fn(async () => undefined),
    operationBelongsToVectorStore: vi.fn(async () => false),
  };
}

describe("canonical API resource reads", () => {
  it("returns a tenant-scoped vector-store resource rather than an operation projection", async () => {
    const resourceReader = reader();
    const api = buildServer({
      resourceReader,
      resolveIdentity: (candidate) => (candidate === token ? identity : undefined),
    });
    const response = await api.inject({
      method: "GET",
      url: `/v1/vector-stores/${id(9)}`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: id(9),
      tenantId,
      documentCount: 3,
      spacesTruncated: false,
    });
    expect(response.json()).not.toHaveProperty("operationId");
    const hidden = await api.inject({
      method: "GET",
      url: `/v1/vector-stores/${id(99)}`,
      headers,
    });
    expect(hidden.statusCode).toBe(404);
    await api.close();
  });
  it("fails closed on invalid stored vector metadata and enforces response bounds", async () => {
    const invalid = reader();
    vi.mocked(invalid.getVectorStoreResource).mockResolvedValueOnce({
      ...(await invalid.getVectorStoreResource(tenantId, id(9))!),
      storeClass: "unknown",
    } as never);
    const api = buildServer({
      resourceReader: invalid,
      resolveIdentity: (candidate) => (candidate === token ? identity : undefined),
    });
    const corrupted = await api.inject({
      method: "GET",
      url: `/v1/vector-stores/${id(9)}`,
      headers,
    });
    expect(corrupted.statusCode).toBe(409);
    await api.close();
    const bounded = buildServer({
      resourceReader: reader(),
      maximumResourceResponseBytes: 64,
      resolveIdentity: (candidate) => (candidate === token ? identity : undefined),
    });
    const tooLarge = await bounded.inject({
      method: "GET",
      url: `/v1/vector-stores/${id(9)}`,
      headers,
    });
    expect(tooLarge.statusCode).toBe(413);
    await bounded.close();
  });
  it("addresses artifacts and receipts by their own IDs without fabricating operation wrappers", async () => {
    const resourceReader = reader();
    const api = buildServer({
      resourceReader,
      resolveIdentity: (candidate) => (candidate === token ? identity : undefined),
    });
    const artifact = await api.inject({
      method: "GET",
      url: `/v1/artifacts/${id(10)}`,
      headers,
    });
    const receipt = await api.inject({
      method: "GET",
      url: `/v1/receipts/${id(11)}`,
      headers,
    });
    expect(artifact.statusCode).toBe(200);
    expect(artifact.json()).toMatchObject({
      artifactId: id(10),
      tenantId,
      artifactType: "source_capture",
    });
    expect(artifact.json()).not.toHaveProperty("operation");
    expect(receipt.statusCode).toBe(200);
    expect(receipt.json()).toMatchObject({
      id: id(11),
      operationId: id(12),
      executorIdentity: "worker:test",
    });
    expect(receipt.json()).not.toHaveProperty("operation");
    await api.close();
  });

  it("returns the persisted retrieval run and its bounded per-stage explanation", async () => {
    const resourceReader = reader();
    const api = buildServer({
      resourceReader,
      resolveIdentity: (candidate) => (candidate === token ? identity : undefined),
    });
    const run = await api.inject({
      method: "GET",
      url: `/v1/retrieval-runs/${id(20)}`,
      headers,
    });
    const explanation = await api.inject({
      method: "GET",
      url: `/v1/retrieval-runs/${id(20)}/explanation`,
      headers,
    });
    expect(run.statusCode).toBe(200);
    expect(run.json()).toMatchObject({
      id: id(20),
      tenantId,
      plan: { queryIntent: "durable retrieval" },
      evidencePacketIds: [id(22)],
    });
    expect(explanation.statusCode).toBe(200);
    expect(explanation.json()).toMatchObject({
      retrievalRunId: id(20),
      truncated: false,
      candidates: [{ rank: 1, sources: [{ channel: "lexical" }] }],
    });
    await api.close();
  });

  it("does not reveal a resource from a different tenant and validates path IDs", async () => {
    const resourceReader = reader();
    const api = buildServer({
      resourceReader,
      resolveIdentity: (candidate) => (candidate === token ? identity : undefined),
    });
    const absent = await api.inject({
      method: "GET",
      url: `/v1/artifacts/${id(99)}`,
      headers,
    });
    const invalid = await api.inject({
      method: "GET",
      url: "/v1/artifacts/not-a-uuid",
      headers,
    });
    expect(absent.statusCode).toBe(404);
    expect(absent.json()).toMatchObject({ code: "NOT_FOUND" });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: "INVALID_CONTRACT" });
    expect(resourceReader.getArtifactResource).toHaveBeenCalledWith(tenantId, id(99));
    await api.close();
  });

  it("fails closed when the canonical resource store is not configured", async () => {
    const api = buildServer({
      resolveIdentity: (candidate) => (candidate === token ? identity : undefined),
    });
    const response = await api.inject({
      method: "GET",
      url: `/v1/artifacts/${id(10)}`,
      headers,
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      code: "INTERNAL_ERROR",
      title: "Canonical resource store unavailable",
    });
    await api.close();
  });

  it("enforces the configured serialized response bound", async () => {
    const api = buildServer({
      resourceReader: reader(),
      maximumResourceResponseBytes: 32,
      resolveIdentity: (candidate) => (candidate === token ? identity : undefined),
    });
    const response = await api.inject({
      method: "GET",
      url: `/v1/artifacts/${id(10)}`,
      headers,
    });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ code: "LIMIT_EXCEEDED" });
    await api.close();
  });
});
