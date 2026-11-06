import { KnowledgeIntegrationService } from "@aiengineer/knowledge-application";
import {
  PostgresCanonicalRepository,
  PostgresKnowledgeOperationService,
  PostgresVectorStoreLifecycleRepository,
} from "@aiengineer/knowledge-persistence";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { parseWorkerOperationScope, reconcileWorkerScope, runWorkerScope, startWorker } from "./index.js";
import { createCanonicalActivityExecutor, createProductionActivityRegistry } from "./activity-registry.js";
import { CanonicalDurableKnowledgeWorker } from "./canonical-worker.js";
import { DurableKnowledgeWorker } from "./worker.js";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const context = {
  tenantId: id(1),
  operationId: id(2),
  attemptId: id(3),
  correlationId: "worker-corr",
  actor: { kind: "service" as const, id: id(4), serviceIdentity: "knowledge_worker" as const },
  capabilityVersion: "worker/1",
  idempotencyKey: "worker-operation-1",
  reason: "worker test",
  contractVersion: "v1" as const,
};
describe("durable worker", () => {
  it("claims, heartbeats, executes and reconciles", async () => {
    const service = new KnowledgeIntegrationService();
    service.submit(
      "capture",
      { context, input: { url: "https://example.com" }, expectedVersions: { api: "v1" } },
      "https://knowledge.example",
    );
    const worker = new DurableKnowledgeWorker("worker-1", service, (claim) => ({
      operationId: claim.operation.operationId,
      step: claim.step.name,
      fixture: "memory-worker",
    }));
    const first = await worker.runOnce();
    expect(first?.receipt.operationId).toBe(context.operationId);
    expect(first?.operation.state).toBe("queued");
    const second = await worker.runOnce();
    expect(second?.operation.state).toBe("succeeded");
    expect(service.events(context.operationId)?.map((x) => x.type)).toContain("operation.reconciled");
  });
});

describe("worker bootstrap", () => {
  it("uses exact operation reconciliation and claiming when explicitly scoped", async () => {
    const operationId = id(99);
    const reconcile = vi.fn(async () => {
      throw new Error("BROAD_RECONCILE_FORBIDDEN");
    });
    const reconcileOperation = vi.fn(async (value: string) => ({ id: value }));
    const runOnce = vi.fn(async () => {
      throw new Error("BROAD_RUN_FORBIDDEN");
    });
    const runOperationOnce = vi.fn(async (value: string) => ({ operationId: value }));
    const worker = { reconcile, reconcileOperation, runOnce, runOperationOnce };
    expect(parseWorkerOperationScope({ WORKER_OPERATION_ID: operationId })).toBe(operationId);
    await expect(reconcileWorkerScope(worker, operationId)).resolves.toBe(1);
    await expect(runWorkerScope(worker, operationId)()).resolves.toEqual({ operationId });
    expect(reconcile).not.toHaveBeenCalled();
    expect(runOnce).not.toHaveBeenCalled();
    expect(reconcileOperation).toHaveBeenCalledWith(operationId);
    expect(runOperationOnce).toHaveBeenCalledWith(operationId);
  });

  it("rejects malformed operation scope before a worker is started", async () => {
    expect(() => parseWorkerOperationScope({ WORKER_OPERATION_ID: "not-a-uuid" })).toThrow(
      "INVALID_WORKER_OPERATION_ID",
    );
    await expect(
      startWorker({ KNOWLEDGE_PERSISTENCE_MODE: "memory", NODE_ENV: "test", WORKER_OPERATION_ID: "not-a-uuid" }),
    ).rejects.toThrow("INVALID_WORKER_OPERATION_ID");
  });

  it("admits memory persistence only when explicitly requested for development or test", async () => {
    await expect(startWorker({ KNOWLEDGE_PERSISTENCE_MODE: "memory", NODE_ENV: "production" })).rejects.toThrow(
      "IN_MEMORY_PERSISTENCE_NOT_ADMITTED",
    );
    const running = await startWorker({
      KNOWLEDGE_PERSISTENCE_MODE: "memory",
      NODE_ENV: "test",
      WORKER_POLL_MS: "60000",
    });
    expect(running.mode).toBe("memory");
    const stopping = running.stop("test");
    expect(running.stop("again")).toBe(stopping);
    await stopping;
  });

  it("defaults to canonical persistence and fails closed when its tenant/config is absent", async () => {
    await expect(startWorker({ NODE_ENV: "production" })).rejects.toThrow("WORKER_TENANT_ID_REQUIRED");
  });

  it("fails closed when selection is requested without a composed host authority", async () => {
    const locator = JSON.stringify({ id: id(8), digest: `sha256:${"a".repeat(64)}` });
    await expect(
      startWorker({
        NODE_ENV: "test",
        KNOWLEDGE_PERSISTENCE_MODE: "postgres",
        PROMOTION_SELECTION_AUTHORITY_ARTIFACT_JSON: locator,
      }),
    ).rejects.toThrow("PROMOTION_SELECTION_AUTHORITY_REQUIRED");
    await expect(
      startWorker({
        NODE_ENV: "test",
        KNOWLEDGE_PERSISTENCE_MODE: "memory",
        PROMOTION_SELECTION_AUTHORITY_ARTIFACT_JSON: locator,
      }),
    ).rejects.toThrow("PROMOTION_SELECTION_REQUIRES_POSTGRES");
  });

  it("accepts a composed host and keeps startup scoped before persistence connects", async () => {
    const tenantId = id(9);
    const operationId = id(10);
    const host = {
      promotionSelection: {
        selectionPorts: {} as never,
        selectionAuthority: async () => {
          throw new Error("unused");
        },
      },
    };
    await expect(
      startWorker(
        {
          NODE_ENV: "test",
          KNOWLEDGE_PERSISTENCE_MODE: "postgres",
          WORKER_TENANT_ID: tenantId,
          WORKER_OPERATION_ID: operationId,
        },
        host,
      ),
    ).rejects.toThrow("POSTGRES_URL_REQUIRED");
  });
});

describe.skipIf(process.env.RUN_LOCAL_PERSISTENCE_TESTS !== "1")("worker process restart", () => {
  it("executes a PostgreSQL-admitted vector-store creation with immutable actor ownership", async () => {
    const connectionString = process.env.POSTGRES_URL;
    if (!connectionString) throw new Error("POSTGRES_URL_REQUIRED");
    const tenantId = randomUUID(),
      operationId = randomUUID(),
      actorId = randomUUID(),
      repository = new PostgresCanonicalRepository({ connectionString, localOnly: true });
    try {
      const input = {
        schemaVersion: "knowledge.vector-store/v1",
        slug: `worker-store-${randomUUID()}`,
        name: "Worker-created store",
        purpose: "connected handler proof",
        storeClass: "internal_exploratory",
        visibility: "tenant",
        quotaProfile: { maximumDocuments: 1000, maximumBytes: 1000000, maximumSpaces: 8 },
        retentionPolicy: { mode: "duration", days: 90 },
        deletionPolicy: { mode: "review_required", minimumRetentionDays: 30 },
      };
      await new PostgresKnowledgeOperationService(repository).submit(
        "vector_store_create",
        {
          context: {
            tenantId,
            operationId,
            attemptId: randomUUID(),
            correlationId: randomUUID(),
            actor: { kind: "service", id: actorId, serviceIdentity: "knowledge_api" },
            capabilityVersion: "vector-store/v1",
            idempotencyKey: `vector-store:${randomUUID()}`,
            reason: "connected vector store activity",
            contractVersion: "v1",
          },
          input,
          expectedVersions: { api: "v1" },
        },
        "http://127.0.0.1:4100",
      );
      const registry = createProductionActivityRegistry({
        retrieval: repository,
        review: repository,
        vectorStore: new PostgresVectorStoreLifecycleRepository(repository),
      });
      const worker = new CanonicalDurableKnowledgeWorker(
        "vector-store-worker",
        tenantId,
        repository,
        createCanonicalActivityExecutor(repository, registry),
        30_000,
        registry.operationKinds(),
      );
      const result = await worker.runOperationOnce(operationId);
      expect(result?.operation?.status).toBe("succeeded");
      expect(result?.receipt.receiptKind).toBe("create.succeeded");
      expect(result?.receipt.body).toMatchObject({
        ownerIdentity: `service:${actorId}`,
        storeClass: "internal_exploratory",
        documentCount: 0,
      });
    } finally {
      await repository.close();
    }
  });

  it("executes a PostgreSQL-admitted source-vetting operation through the production registry", async () => {
    const connectionString = process.env.POSTGRES_URL;
    if (!connectionString) throw new Error("POSTGRES_URL_REQUIRED");
    const tenantId = randomUUID();
    const operationId = randomUUID();
    const repository = new PostgresCanonicalRepository({ connectionString, localOnly: true });
    try {
      const operations = new PostgresKnowledgeOperationService(repository);
      await operations.submit(
        "source_vetting",
        {
          context: {
            tenantId,
            operationId,
            attemptId: randomUUID(),
            correlationId: randomUUID(),
            actor: { kind: "service", id: randomUUID(), serviceIdentity: "knowledge_api" },
            capabilityVersion: "worker-registry/1.0.0",
            idempotencyKey: `source-vetting:${randomUUID()}`,
            reason: "live worker registry test",
            contractVersion: "v1",
          },
          input: {
            schema_version: "ai-engineer-embedding-bundle/0.1.0",
            store_class: "internal_exploratory",
            video_id: "live-worker-fixture",
            title: "Live worker fixture",
            research_as_of: "2026-09-04",
            primary: {
              engineer: { slug: "engineer", display_name: "Engineer" },
              organization: { slug: "organization", display_name: "Organization" },
            },
            selected_documents: [
              {
                id: "document-1",
                document_kind: "official_docs",
                title: "Durable activities",
                canonical_url: "https://example.com/durable-activities",
                source_role: "official",
                publisher: "Example",
                source_class: "documentation",
                target_vector_spaces: ["engineering_claims"],
                text: "Durable activities need idempotency and fenced leases.",
                entity_slugs: ["organization"],
              },
            ],
            engineering_claims: [],
          },
          expectedVersions: { api: "v1" },
        },
        "http://127.0.0.1:4100",
      );
      const registry = createProductionActivityRegistry({ retrieval: repository, review: repository });
      const worker = new CanonicalDurableKnowledgeWorker(
        "production-registry-test",
        tenantId,
        repository,
        createCanonicalActivityExecutor(repository, registry),
      );

      const result = await worker.runOperationOnce(operationId);
      expect(result?.operation?.status).toBe("succeeded");
      expect(result?.receipt.receiptKind).toBe("vet.succeeded");
      expect(result?.receipt.body).toMatchObject({ accepted: true });
      expect(result?.receipt.body).toMatchObject({ reviewSubjectId: expect.any(String) });
      expect((await repository.listSteps(tenantId, operationId))[0]?.input).toMatchObject({
        schemaVersion: "knowledge-operation-request/v1",
        kind: "source_vetting",
      });
    } finally {
      await repository.close();
    }
  });

  it("fails an unimplemented canonical activity once without recording a false success", async () => {
    const connectionString = process.env.POSTGRES_URL;
    if (!connectionString) throw new Error("POSTGRES_URL_REQUIRED");
    const tenantId = randomUUID();
    const operationId = randomUUID();
    const repository = new PostgresCanonicalRepository({ connectionString, localOnly: true });
    try {
      const operations = new PostgresKnowledgeOperationService(repository);
      await operations.submit(
        "capture",
        {
          context: {
            tenantId,
            operationId,
            attemptId: randomUUID(),
            correlationId: randomUUID(),
            actor: { kind: "service", id: randomUUID(), serviceIdentity: "knowledge_api" },
            capabilityVersion: "worker-registry/1.0.0",
            idempotencyKey: `capture:${randomUUID()}`,
            reason: "fail-closed worker registry test",
            contractVersion: "v1",
          },
          input: { url: "https://example.com" },
          expectedVersions: { api: "v1" },
        },
        "http://127.0.0.1:4100",
      );
      const registry = createProductionActivityRegistry({ retrieval: repository, review: repository });
      const worker = new CanonicalDurableKnowledgeWorker(
        "production-registry-test",
        tenantId,
        repository,
        createCanonicalActivityExecutor(repository, registry),
      );

      await expect(worker.runOperationOnce(operationId)).rejects.toMatchObject({
        code: "UNSUPPORTED_OPERATION_ACTIVITY",
        retryable: false,
      });
      expect((await repository.getOperation(tenantId, operationId))?.status).toBe("failed");
      const [failure] = await repository.listReceipts(tenantId, operationId);
      expect(failure).toMatchObject({
        receiptKind: "failure",
        outcome: "failed",
        body: { errorClass: "UNSUPPORTED_OPERATION_ACTIVITY", retryable: false },
      });
      expect((await repository.listSteps(tenantId, operationId))[0]?.attemptCount).toBe(1);
    } finally {
      await repository.close();
    }
  });

  it("does not lease API-owned retrieval runs from the production worker queue", async () => {
    const connectionString = process.env.POSTGRES_URL;
    if (!connectionString) throw new Error("POSTGRES_URL_REQUIRED");
    const tenantId = randomUUID();
    const operationId = randomUUID();
    const repository = new PostgresCanonicalRepository({ connectionString, localOnly: true });
    try {
      await repository.createOperation({
        id: operationId,
        tenantId,
        operationKind: "retrieval_run",
        idempotencyKey: `api-owned-retrieval:${randomUUID()}`,
        correlationId: randomUUID(),
        actorIdentity: "retrieval-api",
        request: { schemaVersion: "knowledge.retrieval-run/v1" },
        steps: [{ id: randomUUID(), key: "execute", kind: "execute", input: { apiOwned: true } }],
      });
      const registry = createProductionActivityRegistry({ retrieval: repository, review: repository });
      const worker = new CanonicalDurableKnowledgeWorker(
        "production-worker",
        tenantId,
        repository,
        createCanonicalActivityExecutor(repository, registry),
        30_000,
        registry.operationKinds(),
      );

      await expect(worker.runOnce()).resolves.toBeUndefined();
      expect((await repository.listSteps(tenantId, operationId))[0]).toMatchObject({
        status: "queued",
        attemptCount: 0,
      });
      await expect(repository.claimOperation(tenantId, operationId, "retrieval-api")).resolves.toMatchObject({
        operationId,
      });
    } finally {
      await repository.close();
    }
  });

  it("reclaims an abandoned PostgreSQL lease in a fresh OS process", async () => {
    const connectionString = process.env.POSTGRES_URL;
    if (!connectionString) throw new Error("POSTGRES_URL_REQUIRED");
    const tenantId = randomUUID();
    const operationId = randomUUID();
    const repository = new PostgresCanonicalRepository({ connectionString, localOnly: true });
    try {
      await repository.createOperation({
        id: operationId,
        tenantId,
        operationKind: "retrieval_run",
        idempotencyKey: `restart:${randomUUID()}`,
        correlationId: randomUUID(),
        actorIdentity: "restart-test",
        request: { restart: true },
        steps: [{ id: randomUUID(), key: "restart", kind: "restart", input: { durable: true }, maxAttempts: 3 }],
      });
      const fixture = fileURLToPath(new URL("./process-restart-fixture.ts", import.meta.url));
      const run = (mode: "abandon" | "complete") =>
        promisify(execFile)(process.execPath, ["--import", "tsx", fixture], {
          env: {
            ...process.env,
            POSTGRES_URL: connectionString,
            WORKER_TENANT_ID: tenantId,
            WORKER_OPERATION_ID: operationId,
            WORKER_RESTART_FIXTURE_MODE: mode,
          },
        });
      const first = JSON.parse((await run("abandon")).stdout.trim()) as {
        pid: number;
        stepId: string;
        attemptCount: number;
      };
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      const second = JSON.parse((await run("complete")).stdout.trim()) as { pid: number; status: string };
      expect(second.pid).not.toBe(first.pid);
      expect(second.status).toBe("succeeded");
      expect((await repository.listSteps(tenantId, operationId))[0]?.attemptCount).toBe(2);
    } finally {
      await repository.close();
    }
  }, 15_000);
});
