/**
 * Reading what an operation produced, over MCP. The tool runs the application read the API route runs
 * (apps/api/src/tests/operation-result.test.ts holds the same fixture and the same expected body), so an agent
 * with either transport gets the ids the next call needs, and nothing sensitive.
 */
import { describe, expect, it, vi } from "vitest";
import type { KnowledgeOperationPort } from "@aiengineer/knowledge-application";
import { createKnowledgeResourceReads, type LocalApiIdentity } from "@aiengineer/knowledge-host";
import {
  describeReference,
  OperationResultResourceSchema,
  operationContractForTool,
  toolArgumentsExample,
  type OperationContext,
} from "@aiengineer/knowledge-contracts";
import { createMcpToolExecutor } from "../index.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hex = (character: string) => character.repeat(64);
const tenantId = id(1);
const operationId = id(50);
const actor = { kind: "service" as const, id: id(4), serviceIdentity: "mission_control_client" as const };
const identity: LocalApiIdentity = { actor, grants: [{ tenantId, roles: ["knowledge_operator"], scopes: [] }] };
const context: OperationContext = {
  tenantId,
  operationId: id(2),
  attemptId: id(3),
  correlationId: "operation-result-test",
  actor,
  capabilityVersion: "mcp/1",
  idempotencyKey: "operation-result-0001",
  reason: "read what the conversion produced",
  contractVersion: "v1",
};

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

describe("knowledge_operation_result", () => {
  const operationService = {
    get: vi.fn(async (requested: string, tenant?: string) =>
      requested === operationId && tenant === tenantId ? status : undefined,
    ),
    submit: vi.fn(),
    input: async () => undefined,
    list: async () => [],
    events: async () => undefined,
    cancel: async () => undefined,
    retry: async () => undefined,
    reconcile: async () => undefined,
  } as unknown as KnowledgeOperationPort;
  const resources = {
    getReceiptResource: vi.fn(async (tenant: string, receiptId: string) =>
      tenant === tenantId && receiptId === receipt.id ? receipt : undefined,
    ),
  };
  const execute = createMcpToolExecutor({
    operationService,
    apiOrigin: "https://api.example",
    identity,
    knowledge: { reads: createKnowledgeResourceReads({ resources: resources as never, operations: operationService }) },
  });
  const call = (input: unknown, callContext = context) =>
    execute("knowledge_operation_result", "promotion_proposal", { context: callContext, input, expectedVersions: {} });

  it("returns the ids the next call needs, as text and as structured content", async () => {
    const tool = await call({ operationId });
    expect((tool as { isError?: boolean }).isError).not.toBe(true);
    expect(tool.structuredContent).toEqual(expected);
    expect(JSON.parse((tool.content as { text: string }[])[0]?.text ?? "null")).toEqual(expected);
    expect(OperationResultResourceSchema.safeParse(tool.structuredContent).success).toBe(true);
    // The representation a chunk build takes is one read away from the conversion.
    expect((tool.structuredContent as typeof expected).ids.representationId).toEqual([id(71)]);
    expect(resources.getReceiptResource).toHaveBeenCalledWith(tenantId, receipt.id);
    expect(operationService.submit).not.toHaveBeenCalled();
  });

  it("returns nothing sensitive", async () => {
    const text = JSON.stringify(await call({ operationId }));
    for (const withheld of [
      "storagePath",
      "representations/71.json",
      "transformation-worker",
      "worker-step-key-60",
      "fencingToken",
      id(73),
      hex("a"),
    ])
      expect(text, withheld).not.toContain(withheld);
  });

  it("refuses an unknown operation, another tenant and a wrong input", async () => {
    expect(await call({ operationId: id(51) })).toMatchObject({
      isError: true,
      content: [{ text: '{"code":"NOT_FOUND"}' }],
    });
    for (const input of [{}, { operationId: "not-an-id" }, { operationId, extra: true }])
      expect(await call(input), JSON.stringify(input)).toMatchObject({
        isError: true,
        content: [{ text: '{"code":"RESOURCE_ID_REQUIRED"}' }],
      });
    expect(await call({ operationId }, { ...context, tenantId: id(9) })).toMatchObject({
      isError: true,
      content: [{ text: '{"code":"FORBIDDEN"}' }],
    });
  });

  it("is not admitted without the canonical store, and never falls back to the status", async () => {
    const withoutReads = createMcpToolExecutor({ operationService, apiOrigin: "https://api.example", identity });
    expect(
      await withoutReads("knowledge_operation_result", "promotion_proposal", {
        context,
        input: { operationId },
        expectedVersions: {},
      }),
    ).toMatchObject({ isError: true, content: [{ text: '{"code":"CAPABILITY_NOT_ADMITTED"}' }] });
  });

  it("is described like every other operation, with an example its tool accepts", () => {
    const described = describeReference("tool:knowledge_operation_result");
    if (!described.ok || described.description.type !== "tool") throw new Error("the result tool is not described");
    expect(described.description.surfaces).toEqual({
      mcp: ["knowledge_operation_result"],
      cli: ["ks knowledge operation result"],
      http: ["GET /v1/operations/{operationId}/result"],
    });
    expect(described.description.result.name).toBe("OperationResultResource");
    const contract = operationContractForTool("knowledge_operation_result");
    expect(contract && toolArgumentsExample(contract)).toEqual(described.description.example);
  });
});
