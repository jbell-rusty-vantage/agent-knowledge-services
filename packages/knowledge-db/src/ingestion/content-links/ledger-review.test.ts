import { describe, expect, it } from "vitest";
import { ContentLinkIntentSchema, type JsonValue } from "@aiengineer/knowledge-contracts";
import { sha256Digest } from "@aiengineer/knowledge-core";
import type { ArtifactLedger, ArtifactRecord, LineageEdge, PutArtifactInput } from "../../db-read/index.js";
import type { KnowledgeSqlClient } from "../../ports.js";
import { beginContentLedger, finishContentLedger, findContentLedger } from "./ledger.js";
import type { ContentLinkOperationResult, ContentLinkPlan, ContentLinkReceipt } from "./types.js";

type Row = Record<string, unknown>;
const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const reference = (value: number) => ({ id: id(value), digest: sha256Digest(`artifact-${value}`) });
function intentFixture() {
  return ContentLinkIntentSchema.parse({
    schemaVersion: "content-link-intent.v1",
    intentId: "qualified-links",
    context: { tenantId: id(1), missionId: id(2), attemptId: id(3), actor: { kind: "agent", id: "reconciler" } },
    contract: {
      migrationHead: "20260914010800",
      workspaceFingerprint: sha256Digest("workspace"),
      policyDigest: sha256Digest("policy"),
    },
    inputSnapshot: { artifact: reference(4), knowledgeSeq: 8 },
    expectedKnowledgeHead: 8,
    asOf: "2026-09-14T00:00:00Z",
    operations: [
      {
        operationId: "link",
        kind: "chunk.claim.link",
        dependsOn: [],
        rationale: "Preserve Cafe\u0301 😀 exactly.",
        applicability: { validFrom: "2026-01-01T00:00:00Z", validTo: null, qualifiers: ["Cafe\u0301 preview only"] },
        chunk: {
          ...reference(12),
          documentVersionId: id(13),
          representation: reference(11),
          captureId: id(14),
          sourceNodes: [{ ...reference(10), representationId: id(11) }],
        },
        claimId: id(15),
        verb: "supports",
        evidence: [
          {
            claimId: id(15),
            claimKey: "capability",
            claimDigest: sha256Digest("claim"),
            runId: id(16),
            manifest: reference(17),
            assessment: reference(18),
            locatorId: id(19),
            captureId: id(14),
            role: "supports",
          },
        ],
      },
    ],
  });
}

function fixture() {
  const intent = intentFixture(),
    intentDigest = sha256Digest(intent as JsonValue),
    idempotencyKey = sha256Digest("execution-key"),
    executorVersion = "content-link/1";
  const operations: ContentLinkOperationResult[] = [
    {
      operationId: "link",
      kind: "chunk.claim.link",
      outcome: "applied",
      dependsOn: [],
      reasons: [],
      canonicalRefs: [
        {
          schema: "retrieval",
          table: "chunk_claim_link",
          key: { tenant_id: id(1), chunk_id: id(12), claim_id: id(15), verb: "supports" },
        },
      ],
    },
  ];
  const plan: ContentLinkPlan = {
    schemaVersion: "content-link-plan.v1",
    intentDigest,
    expectedKnowledgeHead: 8,
    operations: structuredClone(operations),
  };
  const intents: Row[] = [],
    receipts: Row[] = [],
    lineage: Row[] = [],
    records = new Map<string, { record: ArtifactRecord; json?: unknown; text?: string }>();
  const controls = { denyLineage: false, pendingStorage: false, reconciliations: 0, failRows: false, writes: 0 };
  for (const value of [4, 17]) {
    const artifactId = id(value),
      text = `artifact-${value}`;
    records.set(artifactId, {
      text,
      record: {
        artifactId,
        artifactType: value === 4 ? "knowledge_read_snapshot" : "verification_manifest",
        digest: sha256Digest(text),
        bucket: "ledger",
        objectPath: artifactId,
        storageState: "available",
        mediaType: "text/plain",
        sizeBytes: Buffer.byteLength(text),
        reused: false,
      },
    });
  }
  const client: KnowledgeSqlClient = {
    async query<R extends Row>(sql: string, values: readonly unknown[] = []) {
      let rows: Row[] = [];
      if (sql.includes("insert into orchestration.operation_intent")) {
        if (intents.some((row) => row.idempotency_key === values[3]))
          throw Object.assign(new Error("duplicate key"), { code: "23505" });
        intents.push({
          id: values[0],
          intent_type: "content_link",
          schema_version: 1,
          payload: JSON.parse(String(values[1])),
          preconditions: JSON.parse(String(values[2])),
          idempotency_key: values[3],
          proposed_by_attempt: values[4],
          mission_id: values[5],
          approval_state: "approved",
          policy_decision: JSON.parse(String(values[6])),
          tenant_id: values[7],
        });
      } else if (sql.includes("insert into orchestration.operation_receipt")) {
        receipts.push({
          id: values[0],
          intent_id: values[1],
          executor_version: values[2],
          precondition_results: JSON.parse(String(values[3])),
          outcome: values[4],
          changes_summary: JSON.parse(String(values[5])),
          affected_refs: JSON.parse(String(values[6])),
        });
      } else if (sql.includes("from orchestration.artifact_lineage"))
        rows = lineage.filter((row) => row.tenant_id === values[0]);
      else if (sql.includes("left join orchestration.operation_receipt")) {
        rows = intents
          .filter((row) => row.tenant_id === values[0] && row.idempotency_key === values[1])
          .map((row) => ({ ...row, receipt_id: receipts.find((receipt) => receipt.intent_id === row.id)?.id }));
      } else if (sql.includes("from orchestration.operation_receipt r")) {
        rows = receipts
          .filter((row) => row.id === values[1])
          .flatMap((row) => {
            const owner = intents.find(
              (intentRow) =>
                intentRow.id === row.intent_id &&
                intentRow.tenant_id === values[0] &&
                intentRow.intent_type === "content_link",
            );
            return owner ? [{ ...owner, ...row }] : [];
          });
      } else if (sql.includes("select payload,preconditions"))
        rows = intents.filter(
          (row) => row.tenant_id === values[0] && row.id === values[1] && row.intent_type === "content_link",
        );
      else throw new Error(`Unexpected query: ${sql}`);
      return { rows: rows as R[], rowCount: rows.length };
    },
  };
  const artifacts = {
    async putWith(_client: KnowledgeSqlClient, input: PutArtifactInput) {
      controls.writes++;
      expect(input.tenantId).toBe(intent.context.tenantId);
      expect(input.value).toBeUndefined();
      const text = input.text!,
        digest = sha256Digest(text),
        artifactId = input.artifactId ?? id(100 + controls.writes);
      const record: ArtifactRecord = {
        artifactId,
        artifactType: input.artifactType,
        digest,
        bucket: "ledger",
        objectPath: artifactId,
        storageState: controls.pendingStorage ? "pending" : "available",
        mediaType: "application/json",
        sizeBytes: Buffer.byteLength(text),
        reused: false,
      };
      records.set(artifactId, { record, json: JSON.parse(text), text });
      return record;
    },
    async get(tenantId: string, artifactId: string) {
      expect(tenantId).toBe(intent.context.tenantId);
      const value = records.get(artifactId);
      if (!value) throw new Error("missing artifact");
      return value;
    },
    async link(_client: KnowledgeSqlClient, edge: LineageEdge) {
      if (controls.denyLineage) return "denied";
      lineage.push({
        tenant_id: edge.tenantId,
        from_artifact_id: edge.from,
        to_artifact_id: edge.to,
        relation_kind: edge.relation,
        receipt_id: edge.receiptId ?? null,
      });
      return "written";
    },
  } as ArtifactLedger;
  const dependencies = {
    client,
    artifacts,
    async reconcileRows(_receipt: ContentLinkReceipt) {
      controls.reconciliations++;
      if (controls.failRows) throw new Error("canonical composite row missing");
    },
  };
  const begin = () => beginContentLedger(client, { intent, intentDigest, idempotencyKey, executorVersion });
  const finish = async () =>
    finishContentLedger(dependencies, {
      intent,
      plan,
      ids: await begin(),
      operations,
      head: { before: 8, after: operations.some((operation) => operation.outcome === "applied") ? 9 : 8 },
      executorVersion,
    });
  return {
    intent,
    intentDigest,
    idempotencyKey,
    executorVersion,
    operations,
    plan,
    intents,
    receipts,
    lineage,
    records,
    controls,
    dependencies,
    begin,
    finish,
    find: () => findContentLedger(dependencies, { intent, intentDigest, idempotencyKey }),
  };
}

describe("independent offline ledger review findings", () => {
  it("rejects a noncanonical knowledge-head jump", async () => {
    const value = fixture();
    await expect(
      finishContentLedger(value.dependencies, {
        intent: value.intent,
        plan: value.plan,
        ids: await value.begin(),
        operations: value.operations,
        head: { before: 8, after: 100 },
        executorVersion: value.executorVersion,
      }),
    ).rejects.toMatchObject({ code: "CONTENT_LEDGER_CONFLICT" });
    expect(value.controls.writes).toBe(0);
  });
  it.each(["applied", "no_op"] as const)(
    "rejects a %s dependent of a final held prerequisite",
    async (dependentOutcome) => {
      const value = fixture();
      const intent = ContentLinkIntentSchema.parse({
        ...value.intent,
        operations: [
          value.intent.operations[0],
          { ...value.intent.operations[0], operationId: "dependent", dependsOn: ["link"] },
        ],
      });
      const intentDigest = sha256Digest(intent as JsonValue);
      const planned = [
        value.operations[0]!,
        { ...value.operations[0]!, operationId: "dependent", dependsOn: ["link"] },
      ];
      const plan = { ...value.plan, intentDigest, operations: planned };
      const operations: ContentLinkOperationResult[] = [
        { ...planned[0]!, outcome: "held", canonicalRefs: [], reasons: ["Final source withdrawn"] },
        { ...planned[1]!, outcome: dependentOutcome, reasons: ["Final row comparison"] },
      ];
      const ids = await beginContentLedger(value.dependencies.client, {
        intent,
        intentDigest,
        idempotencyKey: value.idempotencyKey,
        executorVersion: value.executorVersion,
      });
      await expect(
        finishContentLedger(value.dependencies, {
          intent,
          plan,
          ids,
          operations,
          head: { before: 8, after: 9 },
          executorVersion: value.executorVersion,
        }),
      ).rejects.toMatchObject({ code: "CONTENT_LEDGER_CONFLICT" });
      expect(value.controls.writes).toBe(0);
    },
  );
  it.each([
    ["canonical producer attempt", "proposed_by_attempt", id(90)],
    ["canonical mission", "mission_id", id(90)],
    ["canonical approval", "approval_state", "denied"],
    ["canonical policy decision", "policy_decision", { policyDigest: sha256Digest("other") }],
    ["canonical schema version", "schema_version", 2],
    ["canonical preconditions", "preconditions", { expectedKnowledgeHead: 0 }],
  ])("rejects %s drift", async (_label, column, changed) => {
    const pending = fixture(),
      ids = await pending.begin();
    pending.intents[0]![String(column)] = changed;
    await expect(
      finishContentLedger(pending.dependencies, {
        intent: pending.intent,
        plan: pending.plan,
        ids,
        operations: pending.operations,
        head: { before: 8, after: 9 },
        executorVersion: pending.executorVersion,
      }),
    ).rejects.toMatchObject({ code: "CONTENT_LEDGER_CONFLICT" });
    expect(pending.controls.writes).toBe(0);
    const value = fixture();
    await value.finish();
    value.intents[0]![String(column)] = changed;
    await expect(value.find()).rejects.toMatchObject({ code: "CONTENT_LEDGER_CONFLICT" });
    expect(value.controls.reconciliations).toBe(0);
  });
  it("rejects canonical receipt precondition drift", async () => {
    const value = fixture();
    await value.finish();
    value.receipts[0]!.precondition_results = { expectedKnowledgeHead: 0 };
    await expect(value.find()).rejects.toMatchObject({ code: "CONTENT_LEDGER_CONFLICT" });
    expect(value.controls.reconciliations).toBe(0);
  });
});
