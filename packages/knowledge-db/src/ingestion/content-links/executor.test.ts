import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContentLinkIntentSchema, type ContentLinkOperation } from "@aiengineer/knowledge-contracts";
import type { ArtifactLedger } from "../../db-read/index.js";
import type { ContentAdmission, KnowledgeDatabase } from "../../ports.js";
import { domainError, type Workspace } from "../../schema-workspace/index.js";
import type { ContentOperationContext, PreparedContentOperation } from "./operations.js";
import type { ContentLinkAuthority, ContentLinkReceipt } from "./types.js";

const mocks = vi.hoisted(() => ({
  preflight: vi.fn(),
  prepare: vi.fn(),
  apply: vi.fn(),
  reconcile: vi.fn(),
  begin: vi.fn(),
  finish: vi.fn(),
  find: vi.fn(),
  receipt: vi.fn(),
}));
vi.mock("../snapshot-preflight.js", () => ({ verifySnapshotPreflight: mocks.preflight }));
vi.mock("./operations.js", () => ({
  prepareContentOperation: mocks.prepare,
  applyPreparedContentOperation: mocks.apply,
  reconcileContentOperationRefs: mocks.reconcile,
}));
vi.mock("./ledger.js", () => ({
  beginContentLedger: mocks.begin,
  finishContentLedger: mocks.finish,
  findContentLedger: mocks.find,
  reconcileContentLedger: mocks.receipt,
}));
import { ContentLinkExecutor } from "./executor.js";

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const digest = (value = "a") => `sha256:${value.repeat(64)}`;
const reference = (value: number) => ({ id: id(value), digest: digest() });
function fixture() {
  const source = { ...reference(10), representationId: id(11) };
  const operation = {
    operationId: "link",
    dependsOn: [],
    evidence: [
      {
        claimId: id(15),
        claimKey: "capability",
        claimDigest: digest(),
        runId: id(16),
        manifest: reference(17),
        assessment: reference(18),
        locatorId: id(19),
        captureId: id(14),
        role: "supports",
      },
    ],
    rationale: "Synthetic executor flow",
    applicability: { validFrom: null, validTo: null, qualifiers: ["in preview"] },
    kind: "chunk.claim.link",
    claimId: id(15),
    verb: "supports",
    chunk: {
      ...reference(12),
      documentVersionId: id(13),
      representation: reference(11),
      captureId: id(14),
      sourceNodes: [source],
    },
  };
  const intent = ContentLinkIntentSchema.parse({
    schemaVersion: "content-link-intent.v1",
    intentId: "executor-unit",
    context: { tenantId: id(1), missionId: id(2), attemptId: id(3), actor: { kind: "agent", id: "fixture" } },
    contract: { migrationHead: "20260914010800", workspaceFingerprint: digest(), policyDigest: digest() },
    inputSnapshot: { artifact: reference(4), knowledgeSeq: 8 },
    expectedKnowledgeHead: 8,
    asOf: "2026-09-14T00:00:00Z",
    operations: [operation],
  });
  const state = {
    head: 8,
    registeredAttempt: true,
    failLock: false,
    failBegin: false,
    failCommit: false,
    loseAcknowledgement: false,
  };
  const events: string[] = [];
  const query = vi.fn(async (sql: string, _values: unknown[]) => {
    events.push(sql);
    if (sql.includes("orchestration.attempt")) return { rows: state.registeredAttempt ? [{ id: id(3) }] : [] };
    if (sql.includes("api.knowledge_head")) return { rows: [{ knowledge_seq: state.head }] };
    if (sql.includes("lock_knowledge_head")) {
      if (state.failLock || state.head !== _values[0])
        throw Object.assign(new Error("rebase_required"), { code: "40001" });
      return { rows: [{ knowledge_seq: state.head }] };
    }
    if (sql.includes("begin_batch")) {
      if (state.failBegin) throw Object.assign(new Error("rebase_required"), { code: "40001" });
      return { rows: [{ k: 9 }] };
    }
    if (sql.includes("commit_batch")) return { rows: [{ k: state.failCommit ? 10 : 9 }] };
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const transaction = vi.fn(
    async (options: { readOnly?: boolean }, callback: (client: unknown) => Promise<unknown>) => {
      const result = await callback({ query });
      if (!options.readOnly && state.loseAcknowledgement) throw new Error("lost acknowledgement");
      return result;
    },
  );
  const db = {
    transaction,
    migrationHead: vi.fn(async () => intent.contract.migrationHead),
  } as unknown as KnowledgeDatabase;
  const snapshot = {
    record: { storageState: "available", digest: intent.inputSnapshot.artifact.digest },
    json: { snapshotDigest: digest("b") },
  };
  const get = vi.fn(async () => snapshot);
  const artifacts = { get } as unknown as ArtifactLedger;
  const authenticate = vi.fn(async () => ({ eligible: true }));
  const admission: ContentAdmission = { readRepresentationAdmission: vi.fn(), persistPreparedSummary: vi.fn() };
  const config = {
    db,
    admission,
    artifacts,
    workspace: {
      migrationHead: intent.contract.migrationHead,
      fingerprint: intent.contract.workspaceFingerprint,
    } as Workspace,
    authority: { authenticate } as unknown as ContentLinkAuthority,
    tenantId: id(1),
    missionId: id(2),
    attemptId: id(3),
    policyDigest: digest(),
    executorVersion: "offline-test",
  };
  return {
    executor: new ContentLinkExecutor(config),
    intent,
    state,
    events,
    query,
    transaction,
    snapshot,
    get,
    authenticate,
    config,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.preflight.mockResolvedValue({});
  mocks.find.mockResolvedValue(undefined);
  mocks.begin.mockResolvedValue({ operationIntentId: id(30), receiptId: id(31), receiptArtifactId: id(32) });
  mocks.prepare.mockImplementation(async (_context: ContentOperationContext, operation: ContentLinkOperation) => ({
    result: {
      operationId: operation.operationId,
      kind: operation.kind,
      dependsOn: operation.dependsOn,
      outcome: "applied",
      reasons: [],
      canonicalRefs: [
        {
          schema: "retrieval",
          table: "chunk_claim_link",
          key: { tenant_id: id(1), chunk_id: id(12), claim_id: id(15) },
        },
      ],
    },
  }));
  mocks.apply.mockImplementation(
    async (_context: ContentOperationContext, prepared: PreparedContentOperation) => prepared.result,
  );
  mocks.finish.mockImplementation(async (_dependencies: unknown, value: Partial<ContentLinkReceipt>) => ({
    ...value,
    receiptId: id(31),
    tenantId: id(1),
    duplicateOf: null,
  }));
});

describe("offline content executor authority and preflight", () => {
  it.each(["tenantId", "missionId", "attemptId"] as const)(
    "rejects host %s drift before custody or database reads",
    async (field) => {
      const f = fixture();
      f.intent.context[field] = id(99);
      await expect(f.executor.plan(f.intent)).rejects.toMatchObject({ code: "CONTENT_AUTHORITY_PIN_MISMATCH" });
      expect(f.get).not.toHaveBeenCalled();
      expect(f.transaction).not.toHaveBeenCalled();
    },
  );
  it("rejects host policy drift", async () => {
    const f = fixture();
    f.intent.contract.policyDigest = digest("c");
    await expect(f.executor.apply(f.intent)).rejects.toMatchObject({ code: "CONTENT_AUTHORITY_PIN_MISMATCH" });
    expect(mocks.find).not.toHaveBeenCalled();
  });
  it.each(["migrationHead", "workspaceFingerprint"] as const)("rejects installed %s mismatch", async (field) => {
    const f = fixture();
    f.intent.contract[field] = field === "migrationHead" ? "20260914010000" : digest("c");
    await expect(f.executor.plan(f.intent)).rejects.toMatchObject({ code: "WORKSPACE_STALE" });
  });
  it("uses the authenticated inner snapshot digest, not its outer artifact digest", async () => {
    const f = fixture();
    await f.executor.plan(f.intent);
    expect(mocks.preflight).toHaveBeenCalledWith(
      expect.objectContaining({
        inputSnapshot: { artifactId: id(4), snapshotDigest: digest("b"), knowledgeSeq: 8 },
        expectedKnowledgeHead: 8,
      }),
      f.config.artifacts,
      f.config.workspace,
    );
    expect(f.transaction).toHaveBeenCalledWith(
      expect.objectContaining({ role: "executor_service", readOnly: true, isolationLevel: "repeatable read" }),
      expect.any(Function),
    );
  });
  it.each(["unavailable", "wrong-digest", "missing-inner"])("rejects %s snapshot custody", async (mode) => {
    const f = fixture();
    if (mode === "unavailable") f.snapshot.record.storageState = "pending";
    if (mode === "wrong-digest") f.snapshot.record.digest = digest("c");
    if (mode === "missing-inner") f.snapshot.json = {} as typeof f.snapshot.json;
    await expect(f.executor.plan(f.intent)).rejects.toMatchObject({ code: "CONTENT_SNAPSHOT_BINDING_INVALID" });
    expect(mocks.preflight).not.toHaveBeenCalled();
  });
  it("propagates snapshot integrity rejection", async () => {
    const f = fixture();
    mocks.preflight.mockRejectedValue(domainError("SNAPSHOT_INVALID", "changed bytes"));
    await expect(f.executor.plan(f.intent)).rejects.toMatchObject({ code: "SNAPSHOT_INVALID" });
    expect(f.transaction).not.toHaveBeenCalled();
  });
  it("requires actual attempt membership in the pinned tenant and mission", async () => {
    const f = fixture();
    f.state.registeredAttempt = false;
    await expect(f.executor.apply(f.intent)).rejects.toMatchObject({ code: "CONTENT_ATTEMPT_BINDING_INVALID" });
    expect(mocks.begin).not.toHaveBeenCalled();
    expect(f.query.mock.calls[0]![1]).toEqual([id(1), id(3), id(2)]);
  });
  it("rejects stale head before preparing effects", async () => {
    const f = fixture();
    f.state.head = 9;
    await expect(f.executor.plan(f.intent)).rejects.toMatchObject({ code: "REBASE_REQUIRED" });
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
  it("rejects an unsupported operation without fallback", async () => {
    const f = fixture();
    const raw = structuredClone(f.intent);
    Object.assign(raw.operations[0]!, { kind: "generic.insert" });
    await expect(f.executor.apply(raw)).rejects.toMatchObject({ code: "CONTENT_INTENT_SCHEMA_INVALID" });
    expect(mocks.find).not.toHaveBeenCalled();
  });
});

describe("offline content executor application and recovery", () => {
  it("expands a summary prerequisite without modifying immutable intent dependencies", async () => {
    const f = fixture(),
      original = f.intent.operations[0]!;
    const common = {
      dependsOn: [],
      evidence: original.evidence,
      applicability: original.applicability,
      rationale: original.rationale,
    };
    f.intent = ContentLinkIntentSchema.parse({
      ...f.intent,
      operations: [
        {
          ...common,
          operationId: "source",
          kind: "summary.source.link",
          summaryId: id(20),
          source: { ...reference(10), representationId: id(11), weight: 1 },
        },
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
          text: "In preview",
          tokenCount: 2,
          sources: [{ ...reference(10), representationId: id(11), weight: 1 }],
        },
      ],
    });
    const plan = await f.executor.plan(f.intent);
    expect(plan.operations.map((value) => value.operationId)).toEqual(["summary", "source"]);
    expect(plan.operations[1]!.dependsOn).toEqual(["summary"]);
    expect(f.intent.operations[0]!.dependsOn).toEqual([]);
  });
  it("holds a rejected dependency closure and still applies an independent effect", async () => {
    const f = fixture();
    f.intent.operations.push(
      { ...f.intent.operations[0]!, operationId: "dependent", dependsOn: ["link"] },
      { ...f.intent.operations[0]!, operationId: "independent" },
    );
    mocks.prepare.mockImplementationOnce(async () => {
      throw domainError("CONTENT_EVIDENCE_NOT_ADMITTED", "unverified");
    });
    const receipt = await f.executor.apply(f.intent);
    expect(receipt.operations.map((value) => [value.operationId, value.outcome])).toEqual([
      ["link", "held"],
      ["dependent", "held"],
      ["independent", "applied"],
    ]);
    expect(receipt.operations[1]).toMatchObject({ canonicalRefs: [], reasons: ["CONTENT_DEPENDENCY_HELD"] });
    expect(f.authenticate).toHaveBeenCalledTimes(2);
    expect(mocks.apply).toHaveBeenCalledTimes(1);
    expect(f.events.findIndex((sql) => sql.includes("begin_batch"))).toBeLessThan(
      f.events.findIndex((sql) => sql.includes("commit_batch")),
    );
    expect(mocks.reconcile).toHaveBeenCalledTimes(3);
  });
  it("does not turn unexpected internal failures into held admission", async () => {
    const f = fixture();
    mocks.prepare.mockRejectedValue(new Error("internal failure"));
    await expect(f.executor.apply(f.intent)).rejects.toThrow("internal failure");
    expect(mocks.finish).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
  });
  it("returns an authenticated duplicate before stale snapshot preflight", async () => {
    const f = fixture();
    const winner = { receiptId: id(31), duplicateOf: id(31) };
    mocks.find.mockResolvedValue(winner);
    await expect(f.executor.apply(f.intent)).resolves.toBe(winner);
    expect(mocks.preflight).not.toHaveBeenCalled();
    expect(mocks.begin).not.toHaveBeenCalled();
  });
  it("recovers a committed receipt after a lost acknowledgement", async () => {
    const f = fixture();
    f.state.loseAcknowledgement = true;
    const winner = { receiptId: id(31), duplicateOf: id(31) };
    mocks.find.mockResolvedValueOnce(undefined).mockResolvedValueOnce(winner);
    await expect(f.executor.apply(f.intent)).resolves.toBe(winner);
    expect(mocks.finish).toHaveBeenCalledTimes(1);
    expect(mocks.apply).toHaveBeenCalledTimes(1);
  });
  it("joins the winner only for the precise idempotency collision", async () => {
    const f = fixture();
    mocks.begin.mockRejectedValue({ code: "23505", constraint: "operation_intent_idempotency_key_key" });
    const winner = { receiptId: id(31), duplicateOf: id(31) };
    mocks.find.mockResolvedValueOnce(undefined).mockResolvedValueOnce(winner);
    await expect(f.executor.apply(f.intent)).resolves.toBe(winner);
    expect(mocks.apply).not.toHaveBeenCalled();
  });
  it("does not swallow an unrelated unique constraint failure", async () => {
    const f = fixture();
    const failure = { code: "23505", constraint: "unrelated_constraint" };
    mocks.begin.mockRejectedValue(failure);
    await expect(f.executor.apply(f.intent)).rejects.toBe(failure);
  });
  it("does not write prepared effects after the batch head race is rejected", async () => {
    const f = fixture();
    f.state.failBegin = true;
    await expect(f.executor.apply(f.intent)).rejects.toMatchObject({ code: "40001" });
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.finish).not.toHaveBeenCalled();
  });
  it("rejects an inconsistent committed batch sequence", async () => {
    const f = fixture();
    f.state.failCommit = true;
    await expect(f.executor.apply(f.intent)).rejects.toThrow("CONTENT_BATCH_COMMIT_MISMATCH");
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });
  it("requires canonical row reconciliation before returning success", async () => {
    const f = fixture();
    mocks.reconcile.mockRejectedValue(new Error("CONTENT_CANONICAL_ROW_MISSING"));
    await expect(f.executor.apply(f.intent)).rejects.toThrow("CONTENT_CANONICAL_ROW_MISSING");
  });
  it.each(["no_op", "held"] as const)(
    "locks the head before preparing an all-%s receipt without opening a batch",
    async (outcome) => {
      const f = fixture();
      mocks.prepare.mockImplementation(async (_context: ContentOperationContext, operation: ContentLinkOperation) => {
        expect(f.events.some((sql) => sql.includes("lock_knowledge_head"))).toBe(true);
        return {
          result: {
            operationId: operation.operationId,
            kind: operation.kind,
            dependsOn: operation.dependsOn,
            outcome,
            reasons: outcome === "held" ? ["CONTENT_EVIDENCE_NOT_ADMITTED"] : [],
            canonicalRefs:
              outcome === "held" ? [] : [{ schema: "retrieval", table: "chunk_claim_link", key: { claim_id: id(15) } }],
          },
        };
      });
      await f.executor.apply(f.intent);
      expect(mocks.finish).toHaveBeenCalledTimes(1);
      expect(f.events.some((sql) => /begin_batch|commit_batch/i.test(sql))).toBe(false);
      expect(f.query).toHaveBeenCalledWith("select temporal.lock_knowledge_head($1::bigint)", [8]);
    },
  );
  it.each(["plan", "apply"] as const)(
    "shares the %s transaction client with canonical evidence authentication",
    async (method) => {
      const f = fixture();
      await f.executor[method](f.intent);
      const authentication = f.authenticate.mock.calls[0] as unknown as [{ client: unknown }];
      const preparation = mocks.prepare.mock.calls[0] as [ContentOperationContext, ContentLinkOperation];
      expect(authentication[0].client).toBe(preparation[0].client);
      expect(preparation[0].client.query).toBe(f.query);
      expect(f.transaction).toHaveBeenCalledTimes(method === "plan" ? 1 : 2);
    },
  );
  it("rejects a stale locked head before ledger insertion or authentication", async () => {
    const f = fixture();
    f.state.failLock = true;
    await expect(f.executor.apply(f.intent)).rejects.toMatchObject({ code: "40001" });
    expect(mocks.begin).not.toHaveBeenCalled();
    expect(f.authenticate).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
});
