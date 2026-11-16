import { describe, expect, it, vi } from "vitest";
import { OperationResultResourceSchema, type DurableReceiptResource } from "@aiengineer/knowledge-contracts";
import { createKnowledgeResourceReads, type KnowledgeResourceReader } from "./knowledge-resource-reads.js";
import { operationResultResource, operationResultStep } from "./operation-result.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hex = (character: string) => character.repeat(64);
const digest = (character: string) => `sha256:${hex(character)}`;
const tenantId = id(1);
const operationId = id(2);

function receipt(n: number, receiptKind: string, body: unknown, outcome = "succeeded"): DurableReceiptResource {
  return {
    id: id(n),
    tenantId,
    operationId,
    stepId: id(n + 100),
    receiptKind,
    idempotencyKey: `step-key-${n}`,
    executorIdentity: "worker-identity",
    inputSha256: hex("a"),
    inputDigest: digest("a"),
    ...(outcome === "succeeded" ? { outputSha256: hex("b"), outputDigest: digest("b") } : {}),
    outcome,
    body: body as DurableReceiptResource["body"],
    createdAt: "2026-01-15T12:00:00.000Z",
  };
}

const conversion = receipt(10, "convert.succeeded", {
  schemaVersion: "knowledge.transformation-result/v1",
  documentId: id(20),
  representationId: id(21),
  artifactDigest: digest("c"),
  conversionGrade: "structural",
  requiresReview: true,
  reviewSubjectId: id(22),
  title: "A page title that is text and must not leave",
  artifact: {
    id: id(23),
    digest: digest("d"),
    byteLength: 4096,
    mediaType: "text/html",
    bucket: "source-captures",
    objectKey: `tenants/${tenantId}/captures/page.html`,
  },
  requestUrl: "https://example.com/private?token=abc",
  eventId: id(24),
  fencingToken: 7,
});

describe("operation result", () => {
  it("keeps identifiers, digests, numbers, flags and state names, and gathers the identifiers by field name", () => {
    const result = operationResultResource({ operationId, kind: "transformation", state: "succeeded" }, [conversion]);
    expect(OperationResultResourceSchema.safeParse(result).success).toBe(true);
    expect(result.steps).toEqual([
      {
        receiptId: id(10),
        receiptKind: "convert.succeeded",
        outcome: "succeeded",
        recordedAt: "2026-01-15T12:00:00.000Z",
        outputDigest: digest("b"),
        output: {
          schemaVersion: "knowledge.transformation-result/v1",
          documentId: id(20),
          representationId: id(21),
          artifactDigest: digest("c"),
          conversionGrade: "structural",
          requiresReview: true,
          reviewSubjectId: id(22),
          artifact: { id: id(23), digest: digest("d"), byteLength: 4096, mediaType: "text/html" },
        },
        // title, artifact.bucket, artifact.objectKey and requestUrl.
        omittedFields: 4,
      },
    ]);
    expect(result.ids).toEqual({
      documentId: [id(20)],
      representationId: [id(21)],
      artifactDigest: [digest("c"), digest("d")],
      reviewSubjectId: [id(22)],
      artifactId: [id(23)],
    });
  });

  it("returns nothing sensitive: no text, address, storage location, executor identity or bookkeeping", () => {
    const text = JSON.stringify(operationResultStep(conversion));
    for (const withheld of [
      "page title",
      "example.com",
      "source-captures",
      "page.html",
      "worker-identity",
      "step-key-10",
      "fencingToken",
      "eventId",
      id(24),
      hex("a"),
    ])
      expect(text, withheld).not.toContain(withheld);
    // A field that names a location is withheld even when its value looks like an identifier.
    const disguised = operationResultStep(receipt(11, "x.succeeded", { leaseToken: id(30), storagePath: digest("e") }));
    expect(disguised.output).toEqual({});
    expect(disguised.omittedFields).toBe(2);
    // A count or an identifier whose name only resembles a withheld word is kept.
    expect(operationResultStep(receipt(12, "x.succeeded", { estimatedTokens: 90, releaseId: id(31) })).output).toEqual({
      estimatedTokens: 90,
      releaseId: id(31),
    });
  });

  it("reads nested and listed identifiers: a benchmark run id and a list of projections", () => {
    const result = operationResultResource({ operationId, kind: "verification_benchmark", state: "succeeded" }, [
      receipt(13, "run_and_register.succeeded", {
        schemaVersion: "verification-operation-result.v1",
        operationId,
        useCase: "runBenchmark",
        output: { benchmarkRunId: id(40), evalRunIds: [id(41), id(42)], manifestDigest: digest("f") },
        resultArtifact: { artifactId: id(43), digest: digest("9"), uri: "s3://bucket/key" },
      }),
      receipt(14, "propose.succeeded", {
        proposalId: id(50),
        projectionIds: [id(51), id(51), id(52)],
        notes: ["free text"],
      }),
    ]);
    expect(result.ids).toMatchObject({
      benchmarkRunId: [id(40)],
      evalRunIds: [id(41), id(42)],
      manifestDigest: [digest("f")],
      artifactId: [id(43)],
      resultArtifactDigest: [digest("9")],
      proposalId: [id(50)],
      projectionIds: [id(51), id(52)],
    });
    expect(result.steps[1]?.output).toEqual({ proposalId: id(50), projectionIds: [id(51), id(51), id(52)] });
    expect(JSON.stringify(result)).not.toContain("s3://");
  });

  it("reports a failed step with its error class and without its message", () => {
    const failed = operationResultStep(
      receipt(
        15,
        "failure",
        { errorClass: "ACQUISITION_VERIFICATION_FAILED", retryable: false, detail: "GET https://x failed" },
        "failed",
      ),
    );
    expect(failed).toMatchObject({
      outcome: "failed",
      output: { errorClass: "ACQUISITION_VERIFICATION_FAILED", retryable: false },
      omittedFields: 1,
    });
    expect(failed.outputDigest).toBeUndefined();
  });

  it("bounds long lists and counts what it left out", () => {
    const many = Array.from({ length: 80 }, (_, index) => id(1000 + index));
    const result = operationResultResource({ operationId, kind: "chunk_set", state: "succeeded" }, [
      receipt(16, "chunk.succeeded", { chunkSetId: id(60), chunkIds: many }),
    ]);
    expect(result.steps[0]?.output).toMatchObject({ chunkSetId: id(60), chunkIds: many.slice(0, 50) });
    expect(result.steps[0]?.omittedFields).toBe(30);
    expect(result.ids.chunkIds).toHaveLength(50);
    expect(result.ids.chunkSetId).toEqual([id(60)]);
  });
});

describe("operation result read", () => {
  const status = { operationId, kind: "transformation", state: "succeeded", receiptIds: [id(10)] };
  const reader = (receipts: Record<string, DurableReceiptResource | undefined>) =>
    ({
      getReceiptResource: vi.fn(async (_tenant: string, receiptId: string) => receipts[receiptId]),
    }) as unknown as KnowledgeResourceReader & { getReceiptResource: ReturnType<typeof vi.fn> };

  it("reads the receipts of the tenant's operation and returns the result", async () => {
    const resources = reader({ [id(10)]: conversion });
    const operations = { get: vi.fn(async () => status) };
    const result = await createKnowledgeResourceReads({ resources, operations }).operationResult(tenantId, operationId);
    expect(result.ok && result.value.ids.representationId).toEqual([id(21)]);
    expect(operations.get).toHaveBeenCalledWith(operationId, tenantId);
    expect(resources.getReceiptResource).toHaveBeenCalledWith(tenantId, id(10));
  });

  it("answers an operation without finished steps with no steps and no ids", async () => {
    const reads = createKnowledgeResourceReads({
      resources: reader({}),
      operations: { get: async () => ({ ...status, state: "queued", receiptIds: [] }) },
    });
    expect(await reads.operationResult(tenantId, operationId)).toEqual({
      ok: true,
      value: { operationId, kind: "transformation", state: "queued", steps: [], ids: {} },
    });
  });

  it("fails closed: unknown operation, missing store, missing receipt and a receipt of another operation", async () => {
    const failure = async (ports: Parameters<typeof createKnowledgeResourceReads>[0]) => {
      const result = await createKnowledgeResourceReads(ports).operationResult(tenantId, operationId);
      return result.ok ? "ok" : result.failure.reason;
    };
    expect(await failure({ resources: reader({}), operations: { get: async () => undefined } })).toBe("not_found");
    expect(await failure({ operations: { get: async () => status } })).toBe("unavailable");
    expect(await failure({ resources: reader({}) })).toBe("unavailable");
    expect(await failure({ resources: reader({}), operations: { get: async () => status } })).toBe("inconsistent");
    expect(
      await failure({
        resources: reader({ [id(10)]: { ...conversion, operationId: id(99) } }),
        operations: { get: async () => status },
      }),
    ).toBe("integrity");
    expect(
      await failure({
        resources: reader({ [id(10)]: { ...conversion, tenantId: id(98) } }),
        operations: { get: async () => status },
      }),
    ).toBe("integrity");
  });
});
