import { describe, expect, it } from "vitest";
import { ContentLinkIntentSchema, type JsonValue } from "@aiengineer/knowledge-contracts";
import { canonicalJson, sha256Digest } from "@aiengineer/knowledge-core";
import type { ArtifactLedger, ArtifactRecord, LineageEdge, PutArtifactInput } from "../../db-read/index.js";
import type { KnowledgeSqlClient } from "../../ports.js";
import { beginContentLedger, finishContentLedger, findContentLedger, reconcileContentLedger } from "./ledger.js";
import type { ContentLinkOperationResult, ContentLinkPlan, ContentLinkReceipt } from "./types.js";
import { orderContentOperations } from "./dependencies.js";

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

describe("content-link ledger custody", () => {
  it("retains the exact full intent, composite affected refs and dependency artifact digests", async () => {
    const value = fixture(),
      receipt = await value.finish();
    expect(value.intents[0]!.payload).toEqual(value.intent);
    expect(value.receipts[0]!.affected_refs).toEqual(value.operations.flatMap((operation) => operation.canonicalRefs));
    expect(value.records.get(receipt.artifacts.intentId)!.text).toContain("Cafe\u0301");
    expect(value.records.get(receipt.artifacts.intentId)!.record.digest).toBe(value.intentDigest);
    expect((value.receipts[0]!.changes_summary as Row).artifacts).toBeDefined();
    expect(await value.find()).toEqual({ ...receipt, duplicateOf: receipt.receiptId });
    expect(value.controls.reconciliations).toBe(1);
    expect(value.lineage).toHaveLength(5);
  });

  it("reconciles the original receipt after an uncertain committed acknowledgement without writing again", async () => {
    const value = fixture(),
      original = await value.finish();
    const writes = value.controls.writes;
    expect(await value.find()).toEqual({ ...original, duplicateOf: original.receiptId });
    expect(value.controls.writes).toBe(writes);
    expect(value.receipts).toHaveLength(1);
  });

  it("returns absent only for an unknown idempotency key", async () => {
    const value = fixture();
    expect(await value.find()).toBeUndefined();
    await value.begin();
    await expect(value.find()).rejects.toThrow(/incomplete/);
  });

  const mutations: readonly [string, (value: ReturnType<typeof fixture>, receipt: ContentLinkReceipt) => void][] = [
    [
      "missing receipt object despite available metadata",
      (value, receipt) => {
        delete value.records.get(receipt.artifacts.receiptId)!.json;
      },
    ],
    [
      "missing full intent object",
      (value, receipt) => {
        delete value.records.get(receipt.artifacts.intentId)!.json;
      },
    ],
    [
      "missing plan object",
      (value, receipt) => {
        delete value.records.get(receipt.artifacts.planId)!.json;
      },
    ],
    [
      "wrong receipt artifact type",
      (value, receipt) => {
        const stored = value.records.get(receipt.artifacts.receiptId)!;
        stored.record = { ...stored.record, artifactType: "knowledge_ingestion_receipt" };
      },
    ],
    [
      "unavailable receipt storage",
      (value, receipt) => {
        const stored = value.records.get(receipt.artifacts.receiptId)!;
        stored.record = { ...stored.record, storageState: "pending" };
      },
    ],
    [
      "altered immutable receipt bytes",
      (value, receipt) => {
        (value.records.get(receipt.artifacts.receiptId)!.json as Row).outcome = "noop";
      },
    ],
    [
      "altered intent evidence",
      (value) => {
        ((value.intents[0]!.payload as Row).operations as Row[])[0]!.evidence = [];
      },
    ],
    [
      "lost composite canonical row key",
      (value) => {
        value.receipts[0]!.affected_refs = [];
      },
    ],
    [
      "different row outcome",
      (value) => {
        value.receipts[0]!.outcome = "rejected";
      },
    ],
    [
      "wrong outer intent type",
      (value) => {
        value.intents[0]!.intent_type = "knowledge_ingestion";
      },
    ],
    [
      "missing artifact lineage",
      (value) => {
        value.lineage.pop();
      },
    ],
    [
      "lineage assigned to another receipt",
      (value) => {
        value.lineage.at(-1)!.receipt_id = id(999);
      },
    ],
    [
      "missing canonical effects",
      (value) => {
        value.controls.failRows = true;
      },
    ],
    [
      "lost original evidence manifest custody",
      (value) => {
        delete value.records.get(id(17))!.text;
      },
    ],
    [
      "changed original snapshot digest",
      (value) => {
        const record = value.records.get(id(4))!;
        record.record = { ...record.record, digest: sha256Digest("changed") };
      },
    ],
  ];
  it.each(mutations)("rejects %s after a successful duplicate read", async (_name, mutate) => {
    const value = fixture(),
      receipt = await value.finish();
    await value.find();
    mutate(value, receipt);
    await expect(value.find()).rejects.toThrow();
  });

  it("refuses a receipt lookup from another tenant", async () => {
    const value = fixture(),
      receipt = await value.finish();
    await expect(
      reconcileContentLedger(value.dependencies, { tenantId: id(999), receiptId: receipt.receiptId }),
    ).rejects.toThrow(/tenant/);
  });

  it.each(["denyLineage", "pendingStorage"] as const)(
    "fails closed when %s prevents durable custody",
    async (control) => {
      const value = fixture();
      value.controls[control] = true;
      await expect(value.finish()).rejects.toThrow();
    },
  );

  it.each(["held", "no_op"] as const)("records %s with its exact outer outcome", async (outcome) => {
    const value = fixture();
    value.operations[0] = {
      ...value.operations[0]!,
      outcome,
      reasons: ["Final state rechecked"],
      canonicalRefs: outcome === "held" ? [] : value.operations[0]!.canonicalRefs,
    };
    const receipt = await value.finish();
    expect(receipt.outcome).toBe(outcome === "held" ? "rejected" : "noop");
    expect(await value.find()).toEqual({ ...receipt, duplicateOf: receipt.receiptId });
  });

  it("refuses a caller digest that normalizes away original qualifiers", async () => {
    const value = fixture(),
      normalized = JSON.parse(canonicalJson(value.intent as JsonValue).normalize("NFC"));
    expect(sha256Digest(normalized)).not.toBe(value.intentDigest);
    await expect(
      beginContentLedger(value.dependencies.client, {
        intent: value.intent,
        intentDigest: sha256Digest(normalized),
        idempotencyKey: value.idempotencyKey,
        executorVersion: value.executorVersion,
      }),
    ).rejects.toThrow(/canonical digest/);
  });

  it("retains omitted summary dependencies in the intent while recording the derived dependency closure", async () => {
    const value = fixture(),
      original = value.intent.operations[0]!;
    const common = {
      dependsOn: [],
      evidence: original.evidence,
      rationale: original.rationale,
      applicability: original.applicability,
    };
    const source = { ...reference(10), representationId: id(11), weight: 1 };
    const intent = ContentLinkIntentSchema.parse({
      ...value.intent,
      operations: [
        { ...common, operationId: "link-source", kind: "summary.source.link", summaryId: id(20), source },
        {
          ...common,
          operationId: "summary",
          kind: "summary.materialize",
          summaryId: id(20),
          documentVersion: reference(13),
          representation: reference(21),
          derivedFrom: reference(11),
          transformationRunId: id(22),
          summaryKind: "technical",
          scope: "document",
          audience: "engineer",
          text: "A qualified summary.",
          tokenCount: 4,
          sources: [source],
        },
      ],
    });
    const intentDigest = sha256Digest(intent as JsonValue);
    const operations: ContentLinkOperationResult[] = orderContentOperations(intent.operations).map(
      ({ operation, dependsOn }) => ({
        operationId: operation.operationId,
        kind: operation.kind,
        dependsOn,
        outcome: "applied",
        reasons: [],
        canonicalRefs: [
          {
            schema: "content",
            table: operation.kind === "summary.materialize" ? "summary" : "summary_source",
            key: operation.kind === "summary.materialize" ? { id: id(20) } : { summary_id: id(20), node_id: id(10) },
          },
        ],
      }),
    );
    const plan: ContentLinkPlan = { ...value.plan, intentDigest, operations };
    const ids = await beginContentLedger(value.dependencies.client, {
      intent,
      intentDigest,
      idempotencyKey: value.idempotencyKey,
      executorVersion: value.executorVersion,
    });
    const input = {
      intent,
      plan,
      ids,
      operations,
      head: { before: 8, after: 9 },
      executorVersion: value.executorVersion,
    };
    const receipt = await finishContentLedger(value.dependencies, input);
    expect(receipt.intent.operations[0]!.dependsOn).toEqual([]);
    expect(receipt.operations.find((operation) => operation.operationId === "link-source")!.dependsOn).toEqual([
      "summary",
    ]);
    expect(
      await reconcileContentLedger(value.dependencies, {
        tenantId: intent.context.tenantId,
        receiptId: receipt.receiptId,
      }),
    ).toEqual(receipt);
    const missingClosure = operations.map((operation) => ({ ...operation, dependsOn: [] }));
    await expect(finishContentLedger(value.dependencies, { ...input, operations: missingClosure })).rejects.toThrow(
      /dependencies differ/,
    );
  });

  it.each(["held", "no_op"] as const)("does not escalate planned %s to an applied effect", async (planned) => {
    const value = fixture(),
      receipt = await value.finish();
    const plan: ContentLinkPlan = {
      ...value.plan,
      operations: value.plan.operations.map((operation) => ({ ...operation, outcome: planned })),
    };
    await expect(
      finishContentLedger(value.dependencies, {
        intent: value.intent,
        plan,
        operations: value.operations,
        ids: {
          operationIntentId: receipt.operationIntentId,
          receiptId: receipt.receiptId,
          receiptArtifactId: receipt.artifacts.receiptId,
        },
        head: receipt.head,
        executorVersion: value.executorVersion,
      }),
    ).rejects.toThrow(/escalates/);
  });
});
