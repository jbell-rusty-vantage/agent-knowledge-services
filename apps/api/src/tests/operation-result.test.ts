/**
 * GET /v1/operations/{operationId}/result: what an operation produced, over HTTP. The route runs the application
 * read the MCP tool knowledge_operation_result runs (apps/mcp/src/tests/operation-result.test.ts holds the same
 * fixture and the same expected body).
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import type { KnowledgeOperationPort } from "@aiengineer/knowledge-host";
import { OperationResultResourceSchema } from "@aiengineer/knowledge-contracts";
import { buildServer } from "../server.js";
import { serviceIdentity, tokenHeaders } from "./support/identity.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hex = (character: string) => character.repeat(64);
const tenantId = id(1);
const operationId = id(50);
const TOKEN = "operation-result-token-00001";
const { identity } = serviceIdentity(tenantId, id(4));

const receipt = {
  id: id(60),
  tenantId,
  operationId,
  stepId: id(61),
  receiptKind: "convert.succeeded",
  idempotencyKey: "worker-step-key-60",
  executorIdentity: "transformation-worker",
  inputSha256: hex("a"),
  inputDigest: `sha256:${hex("a")}`,
  outputSha256: hex("b"),
  outputDigest: `sha256:${hex("b")}`,
  outcome: "succeeded",
  body: {
    schemaVersion: "knowledge.transformation-result/v1",
    documentId: id(70),
    representationId: id(71),
    artifactDigest: `sha256:${hex("c")}`,
    reviewSubjectId: id(72),
    requiresReview: true,
    storagePath: `tenants/${tenantId}/representations/71.json`,
    eventId: id(73),
    fencingToken: 3,
  },
  createdAt: "2026-01-15T12:00:00.000Z",
};
const status = { operationId, kind: "transformation", state: "succeeded", receiptIds: [receipt.id] };

const expected = {
  operationId,
  kind: "transformation",
  state: "succeeded",
  steps: [
    {
      receiptId: receipt.id,
      receiptKind: "convert.succeeded",
      outcome: "succeeded",
      recordedAt: "2026-01-15T12:00:00.000Z",
      outputDigest: `sha256:${hex("b")}`,
      output: {
        schemaVersion: "knowledge.transformation-result/v1",
        documentId: id(70),
        representationId: id(71),
        artifactDigest: `sha256:${hex("c")}`,
        reviewSubjectId: id(72),
        requiresReview: true,
      },
      omittedFields: 1,
    },
  ],
  ids: {
    documentId: [id(70)],
    representationId: [id(71)],
    artifactDigest: [`sha256:${hex("c")}`],
    reviewSubjectId: [id(72)],
  },
};

describe("operation result route", () => {
  const operationService = {
    get: vi.fn(async (requested: string, tenant?: string) =>
      requested === operationId && tenant === tenantId ? status : undefined,
    ),
  } as unknown as KnowledgeOperationPort;
  const resourceReader = {
    getReceiptResource: vi.fn(async (tenant: string, receiptId: string) =>
      tenant === tenantId && receiptId === receipt.id ? receipt : undefined,
    ),
  };
  const resolveIdentity = (token: string) => (token === TOKEN ? identity : undefined);
  const server = buildServer({ operationService, resourceReader: resourceReader as never, resolveIdentity });
  afterAll(() => server.close());
  const get = (operation: string, tenant = tenantId) =>
    server.inject({
      method: "GET",
      url: `/v1/operations/${operation}/result`,
      headers: tokenHeaders(TOKEN, tenant, "operation-result-test"),
    });

  it("returns the ids the next call needs", async () => {
    const response = await get(operationId);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expected);
    expect(OperationResultResourceSchema.safeParse(response.json()).success).toBe(true);
    expect(resourceReader.getReceiptResource).toHaveBeenCalledWith(tenantId, receipt.id);
  });

  it("returns nothing sensitive", async () => {
    const { body } = await get(operationId);
    for (const withheld of [
      "storagePath",
      "representations/71.json",
      "transformation-worker",
      "worker-step-key-60",
      "fencingToken",
      id(73),
      hex("a"),
    ])
      expect(body, withheld).not.toContain(withheld);
  });

  it("refuses an unknown operation, another tenant, a malformed id and a caller without a bearer", async () => {
    const unknown = await get(id(51));
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ code: "NOT_FOUND", title: "Operation not found" });
    expect((await get(operationId, id(9))).statusCode).toBe(403);
    expect((await get("not-an-id")).statusCode).toBe(400);
    const anonymous = await server.inject({ method: "GET", url: `/v1/operations/${operationId}/result` });
    expect(anonymous.statusCode).toBe(401);
  });

  it("answers 503 without the canonical store, and never falls back to the status", async () => {
    const bare = buildServer({ operationService, resolveIdentity });
    const response = await bare.inject({
      method: "GET",
      url: `/v1/operations/${operationId}/result`,
      headers: tokenHeaders(TOKEN, tenantId),
    });
    expect(response.statusCode).toBe(503);
    await bare.close();
  });
});
