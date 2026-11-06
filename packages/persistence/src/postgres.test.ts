import { randomUUID } from "node:crypto";
import { sha256Digest } from "@aiengineer/knowledge-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresCanonicalRepository } from "./postgres.js";

describe("PostgresCanonicalRepository target guard", () => {
  it("refuses a non-local database in local-only mode", () => {
    expect(
      () =>
        new PostgresCanonicalRepository({
          connectionString: "postgresql://example.invalid:5432/postgres",
          localOnly: true,
        }),
    ).toThrow("LOCAL_POSTGRES_REQUIRED");
  });
});

describe.skipIf(process.env.RUN_LOCAL_PERSISTENCE_TESTS !== "1")(
  "PostgresCanonicalRepository local integration",
  () => {
    let database: PostgresCanonicalRepository;
    const tenantId = randomUUID();

    beforeAll(() => {
      const connectionString = process.env.POSTGRES_URL;
      if (!connectionString) throw new Error("POSTGRES_URL_REQUIRED");
      database = new PostgresCanonicalRepository({ connectionString, localOnly: true });
    });

    afterAll(async () => {
      await database?.close();
    });

    const create = (idempotencyKey: string, proposedId = randomUUID(), maxAttempts = 3) =>
      database.createOperation({
        id: proposedId,
        tenantId,
        operationKind: "retrieval_run",
        idempotencyKey,
        correlationId: randomUUID(),
        actorIdentity: "persistence-regression",
        request: { purpose: "persistence-regression" },
        steps: [{ id: randomUUID(), key: "execute", kind: "execute", input: { stable: true }, maxAttempts }],
      });

    it("returns the canonical operation for an idempotent retry with a different proposed id", async () => {
      const key = `regression:idempotent-operation:${randomUUID()}`;
      const first = await create(key);
      const replay = await create(key, randomUUID());
      expect(replay.id).toBe(first.id);
    });

    it("rejects reuse of a durable operation id under another idempotency identity", async () => {
      const operationId = randomUUID();
      await create(`regression:operation-id:first:${randomUUID()}`, operationId);
      await expect(create(`regression:operation-id:second:${randomUUID()}`, operationId)).rejects.toThrow(
        "IDEMPOTENCY_CONFLICT",
      );
    });

    it("does not lease a later durable step before its predecessor succeeds", async () => {
      const operationId = randomUUID();
      await database.createOperation({
        id: operationId,
        tenantId,
        operationKind: "evaluation_run",
        idempotencyKey: `regression:ordered-steps:${randomUUID()}`,
        correlationId: randomUUID(),
        actorIdentity: "persistence-regression",
        request: { purpose: "ordered-steps" },
        steps: [
          { id: randomUUID(), key: "evaluate", kind: "evaluate", input: { step: { name: "evaluate", ordinal: 0 } } },
          { id: randomUUID(), key: "report", kind: "report", input: { step: { name: "report", ordinal: 1 } } },
        ],
      });
      const first = await database.claimOperation(tenantId, operationId, "worker-first");
      expect(first?.stepKey).toBe("evaluate");
      expect(await database.claimOperation(tenantId, operationId, "worker-racing")).toBeUndefined();
      await database.completeStep(tenantId, first!, {
        id: randomUUID(),
        idempotencyKey: `regression:ordered-first:${randomUUID()}`,
        receiptKind: "evaluate.succeeded",
        executorIdentity: "worker-first",
        output: { ok: true },
      });
      expect((await database.claimOperation(tenantId, operationId, "worker-second"))?.stepKey).toBe("report");
    });

    it("terminal-fails and releases the lease when a receipt key collides across semantic identities", async () => {
      const receiptKey = `regression:receipt-collision:${randomUUID()}`;
      const first = await create(`regression:first:${randomUUID()}`);
      const firstLease = await database.claimOperation(tenantId, first.id, "worker-a");
      expect(firstLease).toBeDefined();
      await database.completeStep(tenantId, firstLease!, {
        id: randomUUID(),
        idempotencyKey: receiptKey,
        receiptKind: "regression",
        executorIdentity: "worker-a",
        output: { ok: true },
      });

      const second = await create(`regression:second:${randomUUID()}`);
      const secondLease = await database.claimOperation(tenantId, second.id, "worker-b");
      expect(secondLease).toBeDefined();
      await expect(
        database.completeStep(tenantId, secondLease!, {
          id: randomUUID(),
          idempotencyKey: receiptKey,
          receiptKind: "regression",
          executorIdentity: "worker-b",
          output: { ok: true },
        }),
      ).rejects.toThrow("IDEMPOTENCY_CONFLICT");

      expect((await database.getOperation(tenantId, second.id))?.status).toBe("failed");
      expect((await database.listSteps(tenantId, second.id))[0]?.status).toBe("failed");
      const activeLeaseCount = await database.transaction(tenantId, async (client) =>
        Number(
          (
            await client.query<{ count: string }>(
              "select count(*) count from knowledge_service.lease where tenant_id=$1 and operation_step_id=$2 and released_at is null",
              [tenantId, secondLease!.id],
            )
          ).rows[0]!.count,
        ),
      );
      expect(activeLeaseCount).toBe(0);
    });

    it("terminal-fails a retryable step when its maximum attempts are exhausted", async () => {
      const operation = await create(`regression:max-attempts:${randomUUID()}`, randomUUID(), 1);
      const lease = await database.claimOperation(tenantId, operation.id, "worker-max-attempt");
      expect(lease).toBeDefined();
      await database.failStep(tenantId, lease!, {
        id: randomUUID(),
        idempotencyKey: `regression:max-attempts-receipt:${randomUUID()}`,
        executorIdentity: "worker-max-attempt",
        errorClass: "TRANSIENT_FAILURE",
        retryable: true,
      });
      expect((await database.getOperation(tenantId, operation.id))?.status).toBe("failed");
      expect((await database.listSteps(tenantId, operation.id))[0]?.status).toBe("failed");
    });

    it("fences outbox ack/nack/extension with owner and claim token", async () => {
      const operation = await create(`regression:outbox-fencing:${randomUUID()}`);
      const first = (await database.claimOperationOutbox(tenantId, operation.id, "publisher-a", 1, 5_000))[0];
      expect(first).toMatchObject({ claimOwner: "publisher-a", deliveryAttempts: 1 });
      expect(await database.claimOperationOutbox(tenantId, operation.id, "publisher-b", 1, 5_000)).toEqual([]);
      const extended = await database.extendOutboxClaim(tenantId, first!, 5_000);
      expect(Date.parse(extended)).toBeGreaterThan(Date.now());
      await expect(database.markOutboxPublished(tenantId, { ...first!, claimToken: randomUUID() })).rejects.toThrow(
        /stale or foreign outbox claim/i,
      );
      await database.nackOutbox(tenantId, first!, "BROKER_UNAVAILABLE");
      const retry = (await database.claimOperationOutbox(tenantId, operation.id, "publisher-b", 1, 5_000))[0];
      expect(retry?.claimToken).not.toBe(first?.claimToken);
      expect(retry?.deliveryAttempts).toBe(2);
      await expect(database.markOutboxPublished(tenantId, first!)).rejects.toThrow(/stale or foreign outbox claim/i);
      await database.ackOutbox(tenantId, retry!);
    });

    it("does not disclose lease capability tokens through events or outbox", async () => {
      const operation = await create(`regression:lease-token-redaction:${randomUUID()}`);
      const lease = await database.claimOperation(tenantId, operation.id, "redaction-worker");
      expect(lease).toBeDefined();
      const serialized = await database.transaction(tenantId, async (client) =>
        JSON.stringify(
          (
            await client.query(
              `select e.payload,o.payload outbox_payload from knowledge_service.operation_event e
       join knowledge_service.outbox o on o.tenant_id=e.tenant_id and o.event_id=e.id
       where e.tenant_id=$1 and e.operation_id=$2 and e.event_kind='step.leased'`,
              [tenantId, operation.id],
            )
          ).rows,
        ),
      );
      expect(serialized).not.toContain(lease!.leaseToken);
      expect(serialized).not.toContain("leaseToken");
    });

    it("reads artifact and receipt identities from canonical tenant-scoped rows", async () => {
      const artifactId = randomUUID();
      const digest = sha256Digest("resource-read-artifact").slice(7);
      await database.recordArtifact(tenantId, {
        artifactId,
        artifactType: "source_capture",
        sha256: digest,
        bucketClass: "source_captures",
        storageBucket: "source-captures",
        objectPath: `resource-read/${artifactId}`,
        mediaType: "text/plain",
        sizeBytes: 42,
      });
      expect(await database.getArtifactResource(tenantId, artifactId)).toMatchObject({
        artifactId,
        tenantId,
        artifactType: "source_capture",
        digest: `sha256:${digest}`,
        byteLength: 42,
      });

      const operation = await create(`regression:resource-receipt:${randomUUID()}`);
      const lease = await database.claimOperation(tenantId, operation.id, "resource-reader-worker");
      const receiptId = randomUUID();
      await database.completeStep(tenantId, lease!, {
        id: receiptId,
        idempotencyKey: `regression:resource-receipt-body:${randomUUID()}`,
        receiptKind: "resource-read.succeeded",
        executorIdentity: "resource-reader-worker",
        output: { artifactId },
      });
      expect(await database.getReceiptResource(tenantId, receiptId)).toMatchObject({
        id: receiptId,
        tenantId,
        operationId: operation.id,
        receiptKind: "resource-read.succeeded",
        executorIdentity: "resource-reader-worker",
        outcome: "succeeded",
        body: { artifactId },
      });
      const otherTenant = randomUUID();
      expect(await database.getArtifactResource(otherTenant, artifactId)).toBeUndefined();
      expect(await database.getReceiptResource(otherTenant, receiptId)).toBeUndefined();
    });

    it("reads bounded vector-store metadata and conceals it across tenants", async () => {
      const vectorStoreId = randomUUID();
      await database.transaction(tenantId, async (client) => {
        await client.query(
          `insert into retrieval.vector_store(id,tenant_id,owner_identity,store_class,slug,name,purpose,visibility) values($1,$2,$3,'exploratory',$4,$5,$6,'tenant')`,
          [
            vectorStoreId,
            tenantId,
            "service:persistence-test",
            `resource-${vectorStoreId}`,
            "Resource read store",
            "tenant-scoped resource read",
          ],
        );
      });
      expect(await database.getVectorStoreResource(tenantId, vectorStoreId)).toMatchObject({
        id: vectorStoreId,
        tenantId,
        ownerIdentity: "service:persistence-test",
        storeClass: "internal_exploratory",
        visibility: "tenant",
        lifecycle: "active",
        documentCount: 0,
        spaces: [],
        spacesTruncated: false,
      });
      expect(await database.getVectorStoreResource(randomUUID(), vectorStoreId)).toBeUndefined();
    });

    it("reads bounded evaluation reports and failed cases from normalized evaluation rows", async () => {
      const datasetId = randomUUID(),
        caseId = randomUUID(),
        runId = randomUUID(),
        outputId = randomUUID();
      const metricDefinitionId = randomUUID(),
        metricId = randomUUID(),
        gateVersionId = randomUUID(),
        gateResultId = randomUUID();
      await database.transaction(tenantId, async (client) => {
        await client.query("insert into evaluation.eval_dataset(id,tenant_id,slug,purpose) values($1,$2,$3,$4)", [
          datasetId,
          tenantId,
          `resource-read-${datasetId}`,
          "resource read integration",
        ]);
        await client.query(
          "insert into evaluation.eval_case(id,tenant_id,dataset_id,external_key,input,expected) values($1,$2,$3,$4,$5::jsonb,$6::jsonb)",
          [
            caseId,
            tenantId,
            datasetId,
            "failed-case",
            JSON.stringify({ query: "test" }),
            JSON.stringify({ answer: "expected" }),
          ],
        );
        await client.query(
          "insert into evaluation.eval_run(id,tenant_id,dataset_id,target_code_ref,config,code_ref) values($1,$2,$3,$4,$5::jsonb,$6)",
          [runId, tenantId, datasetId, "retrieval/resource-reader", JSON.stringify({ k: 10 }), "test@1"],
        );
        await client.query(
          "insert into evaluation.eval_score(id,run_id,case_id,metrics,passed,false_acceptance,false_rejection) values($1,$2,$3,$4::jsonb,false,true,false)",
          [randomUUID(), runId, caseId, JSON.stringify({ recall: 0 })],
        );
        await client.query(
          `insert into evaluation.eval_run_case_output(id,tenant_id,eval_run_id,eval_case_id,plan,candidates,answer,output_sha256)
        values($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8)`,
          [
            outputId,
            tenantId,
            runId,
            caseId,
            JSON.stringify({ spaces: ["engineering_claims"] }),
            JSON.stringify([]),
            JSON.stringify({ abstained: false }),
            "e".repeat(64),
          ],
        );
        await client.query(
          "insert into evaluation.metric_definition(id,tenant_id,slug,version,metric_kind,definition) values($1,$2,$3,1,'retrieval',$4::jsonb)",
          [metricDefinitionId, tenantId, `recall-${metricDefinitionId}`, JSON.stringify({ direction: "higher" })],
        );
        await client.query(
          "insert into evaluation.metric_observation(id,tenant_id,metric_definition_id,eval_run_id,eval_case_id,value,details) values($1,$2,$3,$4,$5,0,$6::jsonb)",
          [
            metricId,
            tenantId,
            metricDefinitionId,
            runId,
            caseId,
            JSON.stringify({ reason: "missing expected result" }),
          ],
        );
        await client.query(
          "insert into evaluation.promotion_gate_version(id,tenant_id,slug,version,definition,definition_sha256) values($1,$2,$3,1,$4::jsonb,$5)",
          [gateVersionId, tenantId, `gate-${gateVersionId}`, JSON.stringify({ minimumRecall: 1 }), "f".repeat(64)],
        );
        await client.query(
          `insert into evaluation.promotion_gate_result(id,tenant_id,gate_version_id,eval_run_id,passed,false_acceptance_count,observations,result_sha256)
        values($1,$2,$3,$4,false,1,$5::jsonb,$6)`,
          [gateResultId, tenantId, gateVersionId, runId, JSON.stringify({ blocked: true }), "a".repeat(64)],
        );
      });
      expect(await database.getEvaluationReportResource(tenantId, runId)).toMatchObject({
        id: runId,
        tenantId,
        datasetId,
        targetKind: "code_ref",
        configuration: { k: 10 },
        metrics: [{ id: metricId, metricDefinitionId, caseId, value: 0 }],
        gates: [{ id: gateResultId, gateVersionId, passed: false, falseAcceptanceCount: 1 }],
      });
      expect(await database.getEvaluationFailuresResource(tenantId, runId)).toMatchObject({
        evaluationRunId: runId,
        truncated: false,
        failures: [
          {
            caseId,
            metrics: { recall: 0 },
            falseAcceptance: true,
            falseRejection: false,
            output: { answer: { abstained: false } },
          },
        ],
      });
      expect(await database.getEvaluationReportResource(randomUUID(), runId)).toBeUndefined();
    });

    it("reconstructs and verifies an evidence packet from normalized durable state", async () => {
      const packetId = randomUUID();
      const planId = randomUUID();
      const runId = randomUUID();
      const policyVersion = randomUUID();
      const core = {
        id: packetId,
        tenantId,
        schemaVersion: "v1",
        createdAt: "2026-09-03T00:00:00.000Z",
        retrievalRunId: runId,
        normalizedQuery: "durable normalized packet",
        plan: {
          policyVersion,
          query: "durable normalized packet",
          intents: ["knowledge_evidence"],
          subqueries: [{ id: "durable", text: "durable normalized packet", coverageRole: "required" }],
          spaces: ["engineering_claims"],
          anchors: { entities: [], concepts: [], useCases: [] },
          hardFilters: [],
          softBoosts: [],
          temporalScope: {},
          candidateK: 10,
          finalK: 5,
          graph: { maxDepth: 0, allowedEdges: [] },
          abstention: { minimumCoverage: 1 },
        },
        authorization: {
          decisionId: randomUUID(),
          tenantId,
          actorId: randomUUID(),
          action: "read",
          resource: `evidence_packet:${packetId}`,
          allowed: true,
          policyVersion,
          reasonCodes: ["tenant_match"],
        },
        procedureVersionIds: [],
        members: [],
        omittedResults: [{ reason: "empty fixture" }],
        coverage: [{ subqueryId: "durable", coverage: 0 }],
        abstention: { recommended: true, reason: "empty fixture" },
        eventIds: [],
        artifactIds: [],
        receiptIds: [],
      };
      const packet = { ...core, digest: sha256Digest(JSON.parse(JSON.stringify(core))) };
      await database.storeEvidencePacket(tenantId, { planId, runId, packetId, packet });
      expect(await database.getEvidencePacket(tenantId, packetId)).toEqual(packet);
      expect(await database.getRetrievalRunResource(tenantId, runId)).toMatchObject({
        id: runId,
        tenantId,
        plan: { id: planId, queryIntent: "durable normalized packet", validated: true },
        evidencePacketIds: [packetId],
      });
      expect(await database.getRetrievalExplanationResource(tenantId, runId)).toEqual(
        expect.objectContaining({
          retrievalRunId: runId,
          candidates: [],
          truncated: false,
        }),
      );
      await expect(
        database.storeEvidencePacket(tenantId, { planId: randomUUID(), runId, packetId, packet }),
      ).rejects.toThrow("EVIDENCE_PACKET_PLAN_RUN_CONFLICT");
      const normalized = await database.transaction(
        tenantId,
        async (client) =>
          (
            await client.query<{ normalized_query: string; member_count: string }>(
              `select ep.normalized_query,(select count(*) from retrieval.packet_member pm where pm.tenant_id=ep.tenant_id and pm.packet_id=ep.id)::text member_count
       from retrieval.evidence_packet ep where ep.tenant_id=$1 and ep.id=$2`,
              [tenantId, packetId],
            )
          ).rows[0],
      );
      expect(normalized).toEqual({ normalized_query: "durable normalized packet", member_count: "0" });
    });
  },
);
