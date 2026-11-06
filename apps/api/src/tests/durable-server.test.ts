import { requireDisposableDatabaseUrl, runLocalPersistenceTests } from "./support/persistence.js";
import { randomUUID } from "node:crypto";
import { AcceptedOperationSchema, OperationStatusSchema } from "@aiengineer/knowledge-contracts";
import { PostgresCanonicalRepository, PostgresKnowledgeOperationService } from "@aiengineer/knowledge-persistence";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serviceIdentity } from "./support/identity.js";
import { buildServer } from "../server.js";

describe.skipIf(!runLocalPersistenceTests)("durable operation API local integration", () => {
  const tenantId = randomUUID();
  const { actor, identity } = serviceIdentity(tenantId, randomUUID());
  const token = "durable-api-test-token";
  let apiRepository: PostgresCanonicalRepository;
  let workerRepository: PostgresCanonicalRepository;
  let api: ReturnType<typeof buildServer>;

  beforeAll(() => {
    const connectionString = requireDisposableDatabaseUrl();
    apiRepository = new PostgresCanonicalRepository({
      connectionString,
      localOnly: true,
    });
    workerRepository = new PostgresCanonicalRepository({
      connectionString,
      localOnly: true,
    });
    api = buildServer({
      operationService: new PostgresKnowledgeOperationService(apiRepository),
      resourceReader: apiRepository,
      publicOrigin: "https://knowledge.example",
      resolveIdentity: (candidate) => (candidate === token ? identity : undefined),
    });
  });

  it("serves canonical artifact and receipt resources across independent database connections", async () => {
    const artifactId = randomUUID();
    const artifactSha256 = "d".repeat(64);
    await workerRepository.recordArtifact(tenantId, {
      artifactId,
      artifactType: "source_capture",
      sha256: artifactSha256,
      bucketClass: "source_captures",
      storageBucket: "source-captures",
      objectPath: `durable-api-resource/${artifactId}`,
      mediaType: "text/plain",
      sizeBytes: 19,
    });
    const artifact = await api.inject({
      method: "GET",
      url: `/v1/artifacts/${artifactId}`,
      headers: {
        authorization: `Bearer ${token}`,
        "x-tenant-id": tenantId,
        "x-correlation-id": "artifact-resource-read",
      },
    });
    expect(artifact.statusCode).toBe(200);
    expect(artifact.json()).toMatchObject({
      artifactId,
      tenantId,
      digest: `sha256:${artifactSha256}`,
      byteLength: 19,
    });
    expect(artifact.json()).not.toHaveProperty("operation");

    const operationContext = context();
    expect((await api.inject(request(operationContext))).statusCode).toBe(202);
    const claim = await workerRepository.claimOperation(
      tenantId,
      operationContext.operationId,
      "separate-resource-worker",
    );
    const receiptId = randomUUID();
    await workerRepository.completeStep(tenantId, claim!, {
      id: receiptId,
      idempotencyKey: `resource-receipt:${randomUUID()}`,
      receiptKind: "resource.succeeded",
      executorIdentity: "separate-resource-worker",
      output: { artifactId },
    });
    const receipt = await api.inject({
      method: "GET",
      url: `/v1/receipts/${receiptId}`,
      headers: {
        authorization: `Bearer ${token}`,
        "x-tenant-id": tenantId,
        "x-correlation-id": "receipt-resource-read",
      },
    });
    expect(receipt.statusCode).toBe(200);
    expect(receipt.json()).toMatchObject({
      id: receiptId,
      tenantId,
      operationId: operationContext.operationId,
      body: { artifactId },
    });
    expect(receipt.json()).not.toHaveProperty("operation");
  });

  afterAll(async () => {
    await api?.close();
    await Promise.all([apiRepository?.close(), workerRepository?.close()]);
  });

  const context = (operationId = randomUUID(), idempotencyKey = `durable:${randomUUID()}`) => ({
    tenantId,
    operationId,
    attemptId: randomUUID(),
    correlationId: `correlation-${randomUUID()}`,
    actor,
    capabilityVersion: "durable-api-test/v1",
    idempotencyKey,
    reason: "prove process-separated durable admission",
    contractVersion: "v1" as const,
  });
  const request = (operationContext: ReturnType<typeof context>) => ({
    method: "POST" as const,
    url: "/v1/reviews",
    headers: {
      authorization: `Bearer ${token}`,
      "x-tenant-id": tenantId,
      "x-correlation-id": operationContext.correlationId,
    },
    payload: {
      context: operationContext,
      input: { subject: "durability" },
      expectedVersions: { api: "v1" },
    },
  });

  it("admits work that a separate repository connection claims and exposes its durable result", async () => {
    const operationContext = context();
    const accepted = await api.inject(request(operationContext));
    expect(accepted.statusCode).toBe(202);
    AcceptedOperationSchema.parse(accepted.json());
    expect(accepted.json()).toMatchObject({
      operationId: operationContext.operationId,
      state: "queued",
    });
    const replayContext = context(randomUUID(), operationContext.idempotencyKey);
    const replay = await api.inject(request(replayContext));
    expect(replay.statusCode).toBe(202);
    expect(replay.json().operationId).toBe(operationContext.operationId);
    const conflicting = request(replayContext);
    conflicting.payload.input.subject = "changed durability input";
    const conflict = await api.inject(conflicting);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    const claimed = await workerRepository.claimOperation(tenantId, operationContext.operationId, "separate-worker");
    expect(claimed).toMatchObject({
      operationId: operationContext.operationId,
      stepKey: "review",
      stepKind: "review",
      attemptCount: 1,
    });
    expect(claimed?.input).toMatchObject({
      schemaVersion: "knowledge-operation-request/v1",
      kind: "review",
      operationInput: { subject: "durability" },
      context: {
        operationId: operationContext.operationId,
        correlationId: operationContext.correlationId,
      },
      step: { name: "review", ordinal: 0 },
    });
    await workerRepository.completeStep(tenantId, claimed!, {
      id: randomUUID(),
      idempotencyKey: `worker:${claimed!.id}:${claimed!.attemptCount}`,
      receiptKind: "review.succeeded",
      executorIdentity: "separate-worker",
      output: { reviewed: true },
    });

    const status = await api.inject({
      method: "GET",
      url: `/v1/operations/${operationContext.operationId}`,
      headers: { authorization: `Bearer ${token}`, "x-tenant-id": tenantId },
    });
    expect(status.statusCode).toBe(200);
    OperationStatusSchema.parse(status.json());
    expect(status.json()).toMatchObject({
      operationId: operationContext.operationId,
      state: "succeeded",
      kind: "review",
      context: operationContext,
    });
    expect(status.json().receiptIds).toHaveLength(1);
    const events = await api.inject({
      method: "GET",
      url: `/v1/operations/${operationContext.operationId}/events`,
      headers: { authorization: `Bearer ${token}`, "x-tenant-id": tenantId },
    });
    expect(events.json().items.map((event: { type: string }) => event.type)).toEqual([
      "operation.created",
      "step.leased",
      "step.succeeded",
    ]);
  });

  it("cancels durably so a separate worker cannot claim the operation", async () => {
    const operationContext = context();
    expect((await api.inject(request(operationContext))).statusCode).toBe(202);
    const cancelled = await api.inject({
      method: "POST",
      url: `/v1/operations/${operationContext.operationId}:cancel`,
      headers: {
        authorization: `Bearer ${token}`,
        "x-tenant-id": tenantId,
        "x-correlation-id": operationContext.correlationId,
      },
      payload: {
        context: operationContext,
        input: { action: "cancel" },
        expectedVersions: { api: "v1" },
      },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({
      operationId: operationContext.operationId,
      state: "cancelled",
    });
    expect(
      await workerRepository.claimOperation(tenantId, operationContext.operationId, "separate-worker"),
    ).toBeUndefined();
  });

  it("retries without reusing a failure receipt identity", async () => {
    const operationContext = context();
    expect((await api.inject(request(operationContext))).statusCode).toBe(202);
    const first = await workerRepository.claimOperation(tenantId, operationContext.operationId, "separate-worker");
    await workerRepository.failStep(tenantId, first!, {
      id: randomUUID(),
      idempotencyKey: `worker-failure:${first!.id}:${first!.attemptCount}`,
      executorIdentity: "separate-worker",
      errorClass: "PERMANENT_TEST_FAILURE",
      retryable: false,
    });

    const retried = await api.inject({
      method: "POST",
      url: `/v1/operations/${operationContext.operationId}:retry`,
      headers: {
        authorization: `Bearer ${token}`,
        "x-tenant-id": tenantId,
        "x-correlation-id": operationContext.correlationId,
      },
      payload: {
        context: operationContext,
        input: { action: "retry" },
        expectedVersions: { api: "v1" },
      },
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toMatchObject({ state: "queued" });
    const second = await workerRepository.claimOperation(tenantId, operationContext.operationId, "separate-worker");
    expect(second?.attemptCount).toBe(2);
    await workerRepository.failStep(tenantId, second!, {
      id: randomUUID(),
      idempotencyKey: `worker-failure:${second!.id}:${second!.attemptCount}`,
      executorIdentity: "separate-worker",
      errorClass: "PERMANENT_TEST_FAILURE",
      retryable: false,
    });
    const receipts = await workerRepository.listReceipts(tenantId, operationContext.operationId);
    expect(receipts.map((receipt) => receipt.idempotencyKey)).toEqual([
      `worker-failure:${first!.id}:1`,
      `worker-failure:${second!.id}:2`,
    ]);
    expect((await workerRepository.getOperation(tenantId, operationContext.operationId))?.status).toBe("failed");
  });
});
