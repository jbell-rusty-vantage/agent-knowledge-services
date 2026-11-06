import { randomUUID } from "node:crypto";
import { productionWorkerStepsByKind } from "@aiengineer/knowledge-application";
import { FixtureAcquisitionAdapter } from "@aiengineer/knowledge-acquisition";
import type { OperationContext, OperationKind } from "@aiengineer/knowledge-contracts";
import { PromotionProposalInputSchema } from "@aiengineer/knowledge-contracts";
import { DeterministicTextConversionProvider } from "@aiengineer/knowledge-preparation";
import { sha256Digest } from "@aiengineer/knowledge-core";
import type {
  CanonicalOperationRecord,
  LeasedStep,
  PersistCaptureInput,
  PersistChunkSetInput,
  PersistedCapture,
  PersistedChunkSet,
  PersistedRepresentation,
  PersistRepresentationInput,
  PreparationRepository,
  RetrievalRepository,
} from "@aiengineer/knowledge-persistence";
import { InMemoryArtifactStore } from "@aiengineer/knowledge-core";
import { describe, expect, it, vi } from "vitest";
import {
  CanonicalActivityError,
  CanonicalActivityRegistry,
  createCanonicalActivityExecutor,
  createProductionActivityRegistry,
  retryableActivityFailure,
} from "./activity-registry.js";

const uuid = () => randomUUID();
const digestHex = (value: unknown) => sha256Digest(JSON.parse(JSON.stringify(value))).slice(7);

function invocation(
  kind: OperationKind,
  stepName: string,
  operationInput: unknown,
  tenantIdOverride?: string,
): { operation: CanonicalOperationRecord; claim: LeasedStep; context: OperationContext } {
  const tenantId = tenantIdOverride ?? uuid();
  const operationId = uuid();
  const idempotencyKey = `worker-activity-${uuid()}`;
  const context: OperationContext = {
    tenantId,
    operationId,
    attemptId: uuid(),
    correlationId: uuid(),
    actor: { kind: "service", id: uuid(), serviceIdentity: "knowledge_api" },
    capabilityVersion: "worker-registry/1.0.0",
    idempotencyKey,
    reason: "activity registry test",
    contractVersion: "v1",
  };
  const request = {
    schemaVersion: "knowledge-operation-request/v1" as const,
    kind,
    input: operationInput,
    expectedVersions: { api: "v1" },
  };
  const operation: CanonicalOperationRecord = {
    id: operationId,
    tenantId,
    operationKind: kind,
    idempotencyKey,
    requestSha256: digestHex(request),
    status: "running",
    rowVersion: 2,
    createdAt: "2026-09-04T12:00:00.000Z",
    updatedAt: "2026-09-04T12:00:01.000Z",
    ownershipMode: "standalone",
    correlationId: context.correlationId,
    actorIdentity: `service:${context.actor.id}`,
    request,
  };
  const input = {
    schemaVersion: "knowledge-operation-request/v1" as const,
    kind,
    operationInput,
    expectedVersions: { api: "v1" },
    context,
    step: { name: stepName, ordinal: 0 },
  };
  const claim: LeasedStep = {
    id: uuid(),
    tenantId,
    operationId,
    stepKey: stepName,
    stepKind: stepName,
    inputSha256: digestHex(input),
    status: "running",
    attemptCount: 1,
    maxAttempts: 3,
    rowVersion: 2,
    input,
    holderIdentity: "worker-test",
    leaseToken: uuid(),
    fencingToken: 1,
    expiresAt: "2026-09-04T12:01:00.000Z",
  };
  return { operation, claim, context };
}

function retrievalDependencies(overrides: Partial<RetrievalRepository> = {}) {
  return {
    annNearest: vi.fn(async () => [
      { vectorItemId: "vector-a", score: 0.99 },
      { vectorItemId: "vector-b", score: 0.9 },
    ]),
    exactNearest: vi.fn(async () => [
      { vectorItemId: "vector-a", score: 0.99 },
      { vectorItemId: "vector-b", score: 0.9 },
    ]),
    storeEvidencePacket: vi.fn(async (_tenantId: string, input: { packetId: string }) => input.packetId),
    ...overrides,
  } satisfies Pick<RetrievalRepository, "annNearest" | "exactNearest" | "storeEvidencePacket">;
}

function productionDependencies(overrides: Partial<RetrievalRepository> = {}) {
  return {
    retrieval: retrievalDependencies(overrides),
    review: {
      createReviewSubject: vi.fn(async (_tenantId: string, input: { id: string }) => input.id),
      recordReviewDecision: vi.fn(async (_tenantId: string, input: { id: string }) => input.id),
    },
  };
}

function stepClaim(run: ReturnType<typeof invocation>, stepName: string, ordinal: number): LeasedStep {
  const input = { ...(run.claim.input as Record<string, unknown>), step: { name: stepName, ordinal } };
  return { ...run.claim, stepKey: stepName, stepKind: stepName, input, inputSha256: digestHex(input) };
}

function selectedPromotionFixture() {
  const tenantId = uuid(),
    claimId = uuid(),
    chunkId = uuid(),
    digest = sha256Digest("qualified selection");
  const input = PromotionProposalInputSchema.parse({
    schemaVersion: "knowledge.promotion-proposal/v1",
    selectionArtifact: { id: uuid(), digest },
    chunkSetId: uuid(),
    representationDecisionId: uuid(),
    projectionProcedureId: uuid(),
    purpose: "Selected engineering evidence",
    contextualPrefix: "",
    visibility: "internal",
    classification: "internal",
    targetDomains: ["engineering_claims"],
    expectedValue: "Retained qualification",
    risks: [],
    exclusions: [],
    reason: "Selected close-out",
    selection: {
      schemaVersion: "promotion-selection.v1",
      tenantId,
      expectedKnowledgeHead: 3,
      runPinDigest: digest,
      policyDigest: digest,
      proposedBy: uuid(),
      requiredReviewer: uuid(),
      budget: { maxMembers: 1, maxBytes: 1000, maxTokens: 1000, maxCostMicros: 0, deadline: "2099-01-01T00:00:00Z" },
      excluded: [],
      selected: [
        {
          memberId: "qualified",
          content: { kind: "claim", id: claimId, digest },
          target: { kind: "claim", canonicalId: claimId, projectionTargetId: uuid() },
          targetSpaces: ["engineering_claims"],
          sourceChunks: [
            {
              chunkId,
              chunkDigest: digest,
              representationId: uuid(),
              representationDigest: digest,
              representationClass: "structural_extraction",
              captureId: uuid(),
              sourceFamilyId: "primary",
            },
          ],
          admittedClaims: [{ runId: uuid(), claimId: "native-claim", claimDigest: digest, admissionDigest: digest }],
          contentLinkReceiptIds: [uuid()],
          reason: "Exact admitted claim",
          estimatedBytes: 20,
          estimatedTokens: 5,
          estimatedCostMicros: 0,
        },
      ],
    },
  });
  const proposed = {
    proposalId: uuid(),
    proposalDigest: digest,
    projectionIds: [uuid()],
    projectionManifestDigest: digest,
    chunkSetId: input.chunkSetId,
    representationId: input.selection.selected[0]!.sourceChunks[0]!.representationId,
    selectionDigest: digest,
  };
  const persistProjectionProposal = vi.fn(async () => proposed);
  const dependencies = productionDependencies();
  const registry = createProductionActivityRegistry({
    ...dependencies,
    governedIndex: {
      repository: { persistProjectionProposal } as never,
      embeddingAdapter: {} as never,
      embeddingAdapterVersion: "selection-test",
    },
  });
  const original = invocation("promotion_proposal", "propose", input, tenantId);
  const context: OperationContext = {
    ...original.context,
    actor: { kind: "service", id: input.selection.proposedBy, serviceIdentity: "content_curator_agent" },
  };
  const activityInput = { ...(original.claim.input as Record<string, unknown>), context };
  const run = {
    context,
    operation: { ...original.operation, actorIdentity: `service:${context.actor.id}` },
    claim: { ...original.claim, input: activityInput, inputSha256: digestHex(activityInput) },
  };
  return { input, proposed, persistProjectionProposal, registry, run, review: dependencies.review };
}

describe("selected candidate evaluation identity", () => {
  it.each(["different_actor", "wrong_service", "authenticated_evaluator", "prefixed_evaluator"])(
    "enforces evaluation authority for %s",
    async (mode) => {
      const fixture = selectedPromotionFixture();
      const digest = sha256Digest("evaluation candidate"),
        evaluatorIdentity = uuid();
      const candidate = {
        schemaVersion: "knowledge.selected-candidate-index/v1",
        selection: fixture.input.selection,
        selectionArtifact: { id: uuid(), digest },
        preparation: { operationId: uuid(), receiptId: uuid(), proposalId: uuid() },
        review: { operationId: uuid(), receiptId: uuid(), decisionId: uuid() },
        embeddings: [
          {
            operationId: uuid(),
            receiptId: uuid(),
            embeddingRunId: uuid(),
            vectorSpaceVersionId: uuid(),
            projectionIds: [uuid()],
          },
        ],
      };
      const payload = {
        schemaVersion: "knowledge.selected-candidate-evaluation/v1",
        candidate,
        candidateEvidenceDigest: digest,
        evaluatorIdentity: mode === "prefixed_evaluator" ? `service:${evaluatorIdentity}` : evaluatorIdentity,
        queries: [{ queryId: "candidate", embedding: Array.from({ length: 1536 }, () => 0.1) }],
        resultLimit: 4,
        minimumRecallAtK: 1,
      };
      const evaluateSelectedCandidate = vi.fn(async () => ({ passed: true }));
      const registry = createProductionActivityRegistry({
        ...productionDependencies(),
        governedIndex: {
          repository: { evaluateSelectedCandidate } as never,
          embeddingAdapter: {} as never,
          embeddingAdapterVersion: "evaluation-test",
        },
      });
      const original = invocation("vector_store_evaluation", "evaluate", payload);
      const context: OperationContext = {
        ...original.context,
        actor: {
          kind: "service",
          id: mode === "different_actor" ? uuid() : evaluatorIdentity,
          serviceIdentity: mode === "wrong_service" ? "control_plane" : "evaluation_executor",
        },
      };
      const input = { ...(original.claim.input as Record<string, unknown>), context };
      const result = registry.execute(
        { ...original.operation, actorIdentity: `service:${context.actor.id}` },
        { ...original.claim, input, inputSha256: digestHex(input) },
      );
      if (mode === "different_actor" || mode === "wrong_service") {
        await expect(result).rejects.toMatchObject({ code: "EVALUATION_ACTOR_IDENTITY_MISMATCH", retryable: false });
        expect(evaluateSelectedCandidate).not.toHaveBeenCalled();
      } else {
        await expect(result).resolves.toEqual({ passed: true });
        expect(evaluateSelectedCandidate).toHaveBeenCalledOnce();
      }
    },
  );
});

describe("selected rollback baseline admission", () => {
  it.each(["missing", "subset", "wrong_space", "complete"])(
    "checks %s baseline before accepting rollback plan",
    async (mode) => {
      const guardedDigest = sha256Digest("rollback"),
        vectorStoreSpaceId = uuid();
      const embedding = Array.from({ length: 1536 }, () => 0.1);
      const queries = ["first", "second"].map((queryId) => ({ queryId, embedding }));
      const planRollback = vi.fn(async () => ({
        guardedDigest,
        vectorStoreSpaceId,
        frozenBaseline: queries.map((query) => ({
          queryId: query.queryId,
          embeddingDigest: sha256Digest(query.embedding),
        })),
      }));
      const registry = createProductionActivityRegistry({
        ...productionDependencies(),
        governedIndex: {
          repository: { planRollback } as never,
          embeddingAdapter: {} as never,
          embeddingAdapterVersion: "rollback-test",
        },
      });
      const original = invocation("publication_rollback", "rollback", {
        schemaVersion: "knowledge.publication-rollback/v1",
        currentPublicationId: uuid(),
        targetPublicationId: uuid(),
        guardedDigest,
        reason: "Restore evaluated baseline",
        ...(mode === "missing"
          ? {}
          : {
              vectorStoreSpaceId: mode === "wrong_space" ? uuid() : vectorStoreSpaceId,
              baselineQueries: mode === "subset" ? queries.slice(0, 1) : queries,
            }),
      });
      const context: OperationContext = {
        ...original.context,
        actor: { kind: "service", id: uuid(), serviceIdentity: "control_plane" },
      };
      const input = { ...(original.claim.input as Record<string, unknown>), context };
      const result = registry.execute(
        { ...original.operation, actorIdentity: `service:${context.actor.id}` },
        { ...original.claim, input, inputSha256: digestHex(input) },
      );
      if (mode === "complete") await expect(result).resolves.toMatchObject({ vectorStoreSpaceId, guardedDigest });
      else await expect(result).rejects.toMatchObject({ code: "ROLLBACK_BASELINE_REQUIRED", retryable: false });
    },
  );
});

describe("selected embedding replay authority", () => {
  it.each(["embed", "verify"])("reauthenticates before returning a retained run during %s", async (stepName) => {
    const loadEmbeddingContext = vi.fn(async () => {
      throw new Error("CONTENT_SOURCE_BINDING_INVALID");
    });
    const getEmbeddingRunByOperation = vi.fn(async () => ({ status: "succeeded", itemCount: 1 }));
    const embedMany = vi.fn();
    const registry = createProductionActivityRegistry({
      ...productionDependencies(),
      governedIndex: {
        repository: { loadEmbeddingContext, getEmbeddingRunByOperation } as never,
        embeddingAdapter: { embedMany } as never,
        embeddingAdapterVersion: "replay-test",
      },
    });
    const original = invocation("embedding_run", stepName, {
      schemaVersion: "knowledge.embedding-run/v1",
      vectorSpaceVersionId: uuid(),
      promotionDecisionId: uuid(),
      projectionIds: [uuid()],
      providerRoute: ["deterministic-fake"],
      expectedDimensions: 1536,
      modelSlug: "fake",
    });
    const context: OperationContext = {
      ...original.context,
      actor: { kind: "service", id: uuid(), serviceIdentity: "embedding_executor" },
    };
    const input = {
      ...(original.claim.input as Record<string, unknown>),
      context,
      step: { name: stepName, ordinal: stepName === "embed" ? 0 : 1 },
    };
    await expect(
      registry.execute(
        { ...original.operation, actorIdentity: `service:${context.actor.id}` },
        { ...original.claim, input, inputSha256: digestHex(input) },
      ),
    ).rejects.toThrow("CONTENT_SOURCE_BINDING_INVALID");
    expect(loadEmbeddingContext).toHaveBeenCalledOnce();
    expect(getEmbeddingRunByOperation).not.toHaveBeenCalled();
    expect(embedMany).not.toHaveBeenCalled();
  });
});

describe("selected promotion worker operation", () => {
  it.each(["prepare", "embed", "index"])(
    "reconciles the selected candidate at %s only under executor authority",
    async (stepName) => {
      const f = selectedPromotionFixture();
      const input = {
        schemaVersion: "knowledge.selected-candidate-index/v1",
        selection: f.input.selection,
        selectionArtifact: f.input.selectionArtifact,
        preparation: { operationId: uuid(), receiptId: uuid(), proposalId: uuid() },
        review: { operationId: uuid(), receiptId: uuid(), decisionId: uuid() },
        embeddings: [
          {
            operationId: uuid(),
            receiptId: uuid(),
            embeddingRunId: uuid(),
            vectorSpaceVersionId: uuid(),
            projectionIds: [uuid()],
          },
        ],
      };
      const result = {
        schemaVersion: "knowledge.selected-candidate-index-result/v1",
        selectionDigest: input.selectionArtifact.digest,
        evidenceDigest: sha256Digest("candidate evidence"),
        indexed: true,
        publishable: false,
      };
      const verifySelectedCandidate = vi.fn(async () => result);
      const registry = createProductionActivityRegistry({
        ...productionDependencies(),
        governedIndex: {
          repository: { verifySelectedCandidate } as never,
          embeddingAdapter: {} as never,
          embeddingAdapterVersion: "index-test",
        },
      });
      const original = invocation("vector_store_ingestion", stepName, input, f.input.selection.tenantId);
      const step = { name: stepName, ordinal: ["prepare", "embed", "index"].indexOf(stepName) };
      const deniedInput = { ...(original.claim.input as Record<string, unknown>), step };
      await expect(
        registry.execute(original.operation, {
          ...original.claim,
          input: deniedInput,
          inputSha256: digestHex(deniedInput),
        }),
      ).rejects.toMatchObject({ code: "CANDIDATE_INDEX_AUTHORITY_REQUIRED", retryable: false });
      expect(verifySelectedCandidate).not.toHaveBeenCalled();
      const context: OperationContext = {
        ...original.context,
        actor: { kind: "service", id: uuid(), serviceIdentity: "embedding_executor" },
      };
      const activityInput = { ...deniedInput, context };
      await expect(
        registry.execute(
          { ...original.operation, actorIdentity: `service:${context.actor.id}` },
          { ...original.claim, input: activityInput, inputSha256: digestHex(activityInput) },
        ),
      ).resolves.toEqual({ ...result, stage: stepName });
      expect(verifySelectedCandidate).toHaveBeenCalledWith(context.tenantId, input);
    },
  );
  it("passes exact selection custody through persistence and into the guarded review subject", async () => {
    const f = selectedPromotionFixture();
    await expect(f.registry.execute(f.run.operation, f.run.claim)).resolves.toMatchObject({
      selectionDigest: f.input.selectionArtifact.digest,
      publishable: false,
      requiresIndependentDecision: true,
    });
    expect(f.persistProjectionProposal).toHaveBeenCalledWith(
      f.run.context.tenantId,
      expect.objectContaining({
        selection: f.input.selection,
        selectionArtifact: f.input.selectionArtifact,
        proposedBy: f.input.selection.proposedBy,
      }),
    );
    expect(f.review.createReviewSubject).toHaveBeenCalledWith(
      f.run.context.tenantId,
      expect.objectContaining({
        guardedSha256: f.proposed.proposalDigest.slice(7),
        subjectRef: expect.objectContaining({
          selectionDigest: f.input.selectionArtifact.digest,
          selectionArtifactId: f.input.selectionArtifact.id,
        }),
      }),
    );
  });
  it("rejects legacy whole-chunk-set payloads before persistence or review", async () => {
    const f = selectedPromotionFixture();
    const { selection, selectionArtifact, ...legacy } = f.input;
    const run = invocation("promotion_proposal", "propose", legacy, f.run.context.tenantId);
    await expect(f.registry.execute(run.operation, run.claim)).rejects.toMatchObject({
      code: "INVALID_ACTIVITY_INPUT",
      retryable: false,
      cause: {
        issues: expect.arrayContaining([
          expect.objectContaining({ path: ["selection"] }),
          expect.objectContaining({ path: ["selectionArtifact"] }),
        ]),
      },
    });
    expect(f.persistProjectionProposal).not.toHaveBeenCalled();
    expect(f.review.createReviewSubject).not.toHaveBeenCalled();
  });
  it("refuses a persistence result bound to another selection before creating a review", async () => {
    const f = selectedPromotionFixture();
    f.persistProjectionProposal.mockResolvedValue({
      ...f.proposed,
      selectionDigest: sha256Digest("different selection"),
    });
    await expect(f.registry.execute(f.run.operation, f.run.claim)).rejects.toMatchObject({
      code: "PROMOTION_SELECTION_RESULT_MISMATCH",
      retryable: false,
    });
    expect(f.review.createReviewSubject).not.toHaveBeenCalled();
  });
});

function documentNode(representationId: string, nodeId: string, text: string, ordinal = 0) {
  return {
    id: nodeId,
    tenantId: uuid(),
    digest: sha256Digest(text),
    schemaVersion: "v1" as const,
    createdAt: "2026-09-04T12:00:00.000Z",
    representationId,
    ordinal,
    kind: "paragraph" as const,
    text,
    locator: { representationId, nodeId, startOffset: 0, endOffset: text.length, quoteDigest: sha256Digest(text) },
  };
}

function preparationFixture() {
  const artifacts = new InMemoryArtifactStore();
  let capture: PersistedCapture | undefined;
  let representation: PersistedRepresentation | undefined;
  let nodes: PersistRepresentationInput["nodes"] = [];
  let chunkSet: PersistedChunkSet | undefined;
  const repository: PreparationRepository = {
    persistCapture: vi.fn(async (_tenantId: string, input: PersistCaptureInput) => (capture = { ...input })),
    getCaptureByOperation: vi.fn(async (_tenantId: string, operationId: string) =>
      capture?.operationId === operationId ? capture : undefined,
    ),
    persistRepresentation: vi.fn(async (_tenantId: string, input: PersistRepresentationInput) => {
      nodes = input.nodes;
      representation = {
        operationId: input.operationId,
        transformationRunId: input.transformationRunId,
        documentId: input.documentId,
        documentVersionId: input.documentVersionId,
        sourceNativeRepresentationId: input.sourceNativeRepresentationId,
        structuralRepresentationId: input.structuralRepresentationId,
        structuralArtifactDigest: input.structuralArtifactDigest,
        nodeCount: input.nodes.length,
        acceptanceState: "pending",
        conversionGrade: input.fidelity.grade,
        receipt: input.receipt,
      };
      return representation;
    }),
    getRepresentationByOperation: vi.fn(async (_tenantId: string, operationId: string) =>
      representation?.operationId === operationId ? representation : undefined,
    ),
    getRepresentationNodes: vi.fn(async (_tenantId: string, representationId: string) =>
      representation?.structuralRepresentationId === representationId ? nodes : [],
    ),
    persistChunkSet: vi.fn(
      async (_tenantId: string, input: PersistChunkSetInput) =>
        (chunkSet = {
          operationId: input.operationId,
          chunkSetId: input.chunkSetId,
          representationId: input.representationId,
          inputDigest: input.inputDigest,
          outputDigest: input.outputDigest,
          chunkCount: input.chunks.length,
          spanCount: input.chunks.reduce((sum, item) => sum + item.spans.length, 0),
          status: "succeeded",
        }),
    ),
    getChunkSetByOperation: vi.fn(async (_tenantId: string, operationId: string) =>
      chunkSet?.operationId === operationId ? chunkSet : undefined,
    ),
  };
  const acquisition = new FixtureAcquisitionAdapter("direct-http", "http", artifacts, {
    normalizedTarget: "https://example.com/durable-agents",
    mediaType: "text/markdown",
    bytes: new TextEncoder().encode(
      "# Durable agents\n\nDurable activities use fenced leases and idempotent receipts.",
    ),
    observations: { status: "200" },
    identifiers: ["https://example.com/durable-agents"],
  });
  return {
    sourceArtifacts: artifacts,
    derivativeArtifacts: artifacts,
    repository,
    acquisition,
    conversionProviders: [new DeterministicTextConversionProvider(artifacts)],
  };
}

describe("CanonicalActivityRegistry", () => {
  it("requires the sealed authenticated context even when step and request digests are independently valid", () => {
    const fixture = invocation("verification_extraction", "verify_and_register", {});
    const registry = new CanonicalActivityRegistry([]);
    expect(() => registry.parseInvocation(fixture.operation, fixture.claim)).toThrow(
      "Verification step does not match its sealed authenticated context",
    );
    const request = {
      ...(fixture.operation.request as Record<string, unknown>),
      authenticatedContext: fixture.context,
    };
    const operation = { ...fixture.operation, request, requestSha256: digestHex(request) };
    expect(registry.parseInvocation(operation, fixture.claim).activity.context).toEqual(fixture.context);
    const changedRequest = { ...request, authenticatedContext: { ...fixture.context, attemptId: uuid() } };
    expect(() =>
      registry.parseInvocation(
        { ...operation, request: changedRequest, requestSha256: digestHex(changedRequest) },
        fixture.claim,
      ),
    ).toThrow("Verification step does not match its sealed authenticated context");
  });
  it("registers every step in the production worker admission catalog exactly once", () => {
    const durable = preparationFixture();
    const registry = createProductionActivityRegistry({
      ...productionDependencies(),
      review: {
        createReviewSubject: vi.fn(async (_tenantId: string, input: { id: string }) => input.id),
        recordReviewDecision: vi.fn(async (_tenantId: string, input: { id: string }) => input.id),
      },
      vectorStore: { persistVectorStore: vi.fn(), attachDocuments: vi.fn(), verifyIngestionStage: vi.fn() },
      durablePreparation: {
        ...durable,
        sourceStorageBucket: "source-captures",
        derivativeStorageBucket: "content-derivatives",
      },
      governedIndex: {
        repository: {} as never,
        embeddingAdapter: {} as never,
        embeddingAdapterVersion: "parity-test/1",
      },
    });
    const expected = Object.entries(productionWorkerStepsByKind)
      .flatMap(([kind, steps]) => steps.map((step) => `${kind}:${step}`))
      .sort();
    expect(registry.activities()).toEqual(expected);
    expect(registry.operationKinds()).toEqual(Object.keys(productionWorkerStepsByKind).sort());
  });

  it("dispatches only the handler bound to both operation kind and step name", async () => {
    const execute = vi.fn(() => ({ accepted: true }));
    const registry = new CanonicalActivityRegistry([{ operationKind: "source_vetting", stepName: "vet", execute }]);
    const { operation, claim } = invocation("source_vetting", "vet", { source: "fixture" });

    await expect(registry.execute(operation, claim)).resolves.toEqual({ accepted: true });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("fails unsupported work closed and marks it non-retryable", async () => {
    const registry = new CanonicalActivityRegistry([]);
    const { operation, claim } = invocation("capture", "acquire", { url: "https://example.com" });

    const error = await registry.execute(operation, claim).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(CanonicalActivityError);
    expect(error).toMatchObject({ code: "UNSUPPORTED_OPERATION_ACTIVITY", retryable: false });
    expect(retryableActivityFailure(error)).toBe(false);
  });

  it("rejects a non-JSON handler result before a success receipt can be written", async () => {
    const registry = new CanonicalActivityRegistry([
      {
        operationKind: "source_vetting",
        stepName: "vet",
        execute: () => ({ invalid: undefined }),
      },
    ]);
    const { operation, claim } = invocation("source_vetting", "vet", { source: "fixture" });

    await expect(registry.execute(operation, claim)).rejects.toMatchObject({
      code: "INVALID_ACTIVITY_INPUT",
      retryable: false,
    });
  });

  it("rejects a persisted kind that disagrees with the canonical operation", async () => {
    const registry = new CanonicalActivityRegistry([]);
    const { operation, claim } = invocation("source_vetting", "vet", { source: "fixture" });
    const changedInput = { ...(claim.input as Record<string, unknown>), kind: "capture" };
    const changed = { ...claim, input: changedInput, inputSha256: digestHex(changedInput) };

    await expect(registry.execute(operation, changed)).rejects.toMatchObject({
      code: "ACTIVITY_OPERATION_KIND_MISMATCH",
      retryable: false,
    });
  });

  it("loads the canonical operation before invoking a handler", async () => {
    const registry = new CanonicalActivityRegistry([
      {
        operationKind: "source_vetting",
        stepName: "vet",
        execute: () => ({ loaded: true }),
      },
    ]);
    const { operation, claim } = invocation("source_vetting", "vet", { source: "fixture" });
    const getOperationRecord = vi.fn(async () => operation);
    const execute = createCanonicalActivityExecutor({ getOperationRecord }, registry);

    await expect(execute(claim)).resolves.toEqual({ loaded: true });
    expect(getOperationRecord).toHaveBeenCalledWith(operation.tenantId, operation.id);
  });
});

describe("production activity handlers", () => {
  it("binds vector-store ownership to the authenticated actor and rejects unauthorized public/official stores", async () => {
    const persistVectorStore = vi.fn(async (tenantId: string, input: Record<string, unknown>) => ({
      ...input,
      id: input.vectorStoreId,
      tenantId,
      createdAt: "2026-09-04T12:00:00.000Z",
      lifecycle: "active",
      documentCount: 0,
      spaces: [],
      spacesTruncated: false,
    }));
    const registry = createProductionActivityRegistry({
      ...productionDependencies(),
      vectorStore: { persistVectorStore } as never,
    });
    const base = {
      schemaVersion: "knowledge.vector-store/v1",
      slug: "research-sandbox",
      name: "Research sandbox",
      purpose: "bounded exploratory retrieval",
      storeClass: "internal_exploratory",
      visibility: "tenant",
      quotaProfile: { maximumDocuments: 1000, maximumBytes: 1000000, maximumSpaces: 8 },
      retentionPolicy: { mode: "duration", days: 90 },
      deletionPolicy: { mode: "review_required", minimumRetentionDays: 30 },
    };
    const run = invocation("vector_store_create", "create", base);
    await expect(registry.execute(run.operation, run.claim)).resolves.toMatchObject({
      ownerIdentity: `service:${run.context.actor.id}`,
      storeClass: "internal_exploratory",
    });
    expect(persistVectorStore).toHaveBeenCalledWith(
      run.context.tenantId,
      expect.objectContaining({ operationId: run.operation.id, ownerIdentity: `service:${run.context.actor.id}` }),
    );
    const official = invocation("vector_store_create", "create", {
      ...base,
      storeClass: "official_canonical",
      visibility: "public",
    });
    await expect(registry.execute(official.operation, official.claim)).rejects.toMatchObject({
      code: "CONTROL_PLANE_AUTHORITY_REQUIRED",
      retryable: false,
    });
    const publicExploratory = invocation("vector_store_create", "create", { ...base, visibility: "public" });
    await expect(registry.execute(publicExploratory.operation, publicExploratory.claim)).rejects.toMatchObject({
      code: "PUBLIC_STORE_AUTHORITY_REQUIRED",
      retryable: false,
    });
  });

  it("validates and atomically attaches bounded vector-store documents under owner authority", async () => {
    const attachDocuments = vi.fn(async (_tenantId: string, input: Record<string, unknown>) => ({
      vectorStoreId: input.vectorStoreId,
      storeClass: "internal_exploratory",
      ownerIdentity: input.actorIdentity,
      documentIds: (input.documents as { documentId: string }[]).map((item) => item.documentId),
      attachmentIds: (input.documents as { id: string }[]).map((item) => item.id),
      attachmentCount: (input.documents as unknown[]).length,
      state: "requested",
    }));
    const registry = createProductionActivityRegistry({
      ...productionDependencies(),
      vectorStore: { persistVectorStore: vi.fn(), attachDocuments } as never,
    });
    const input = {
      schemaVersion: "knowledge.vector-store-documents/v1",
      vectorStoreId: uuid(),
      documents: [
        {
          documentId: uuid(),
          documentVersionId: uuid(),
          representationId: uuid(),
          requestedProfile: { chunk: "heading-sections-v1" },
        },
      ],
    };
    const run = invocation("vector_store_documents", "validate", input);
    await expect(registry.execute(run.operation, run.claim)).resolves.toMatchObject({ valid: true, documentCount: 1 });
    await expect(registry.execute(run.operation, stepClaim(run, "attach", 1))).resolves.toMatchObject({
      attachmentCount: 1,
      state: "requested",
    });
    expect(attachDocuments).toHaveBeenCalledWith(
      run.context.tenantId,
      expect.objectContaining({
        operationId: run.operation.id,
        actorIdentity: `service:${run.context.actor.id}`,
        documents: [expect.objectContaining({ documentId: input.documents[0]!.documentId, id: expect.any(String) })],
      }),
    );
  });

  it("executes the three typed vector-store ingestion verification stages with one immutable binding", async () => {
    const verifyIngestionStage = vi.fn(async (_tenantId: string, input: Record<string, unknown>, stage: string) => ({
      schemaVersion: "knowledge.vector-store-ingestion-stage/v1",
      ingestionRunId: input.ingestionRunId,
      vectorStoreId: input.vectorStoreId,
      stage,
      attachmentCount: (input.chains as unknown[]).length,
      evidenceDigest: `sha256:${"a".repeat(64)}`,
    }));
    const registry = createProductionActivityRegistry({
      ...productionDependencies(),
      vectorStore: {
        persistVectorStore: vi.fn(),
        attachDocuments: vi.fn(),
        verifyIngestionStage,
      } as never,
    });
    const chain = {
      attachmentId: uuid(),
      transformationOperationId: uuid(),
      chunkSetId: uuid(),
      chunkSetOperationId: uuid(),
      promotionProposalId: uuid(),
      promotionProposalOperationId: uuid(),
      promotionDecisionId: uuid(),
      promotionDecisionOperationId: uuid(),
      embeddingRunId: uuid(),
      embeddingOperationId: uuid(),
      publicationId: uuid(),
      publicationOperationId: uuid(),
    };
    const input = { schemaVersion: "knowledge.vector-store-ingestion/v1", vectorStoreId: uuid(), chains: [chain] };
    const run = invocation("vector_store_ingestion", "prepare", input);
    await expect(registry.execute(run.operation, run.claim)).resolves.toMatchObject({
      stage: "prepared",
      attachmentCount: 1,
    });
    await expect(registry.execute(run.operation, stepClaim(run, "embed", 1))).resolves.toMatchObject({
      stage: "embedded",
    });
    await expect(registry.execute(run.operation, stepClaim(run, "index", 2))).resolves.toMatchObject({
      stage: "indexed",
    });
    expect(verifyIngestionStage.mock.calls.map((call) => call[2])).toEqual(["prepared", "embedded", "indexed"]);
    expect(verifyIngestionStage).toHaveBeenCalledWith(
      run.context.tenantId,
      expect.objectContaining({
        operationId: run.operation.id,
        vectorStoreId: input.vectorStoreId,
        actorIdentity: `service:${run.context.actor.id}`,
        chains: [chain],
      }),
      "prepared",
    );
  });

  it("executes deterministic discovery, resolution, preview, comparison, and experiment receipts", async () => {
    const registry = createProductionActivityRegistry(productionDependencies());
    const discovery = invocation("source_discovery", "discover", {
      schemaVersion: "knowledge.source-discovery/v1",
      query: "agent runtimes",
      limit: 10,
      candidates: [
        {
          url: "https://EXAMPLE.com/docs?b=2&a=1#fragment",
          title: "Docs",
          sourceClass: "official",
          score: 0.9,
          evidence: ["primary"],
        },
        {
          url: "https://example.com/docs?a=1&b=2",
          title: "Duplicate",
          sourceClass: "official",
          score: 0.2,
          evidence: [],
        },
      ],
    });
    const discovered = (await registry.execute(discovery.operation, discovery.claim)) as Record<string, unknown>;
    expect(discovered).toMatchObject({
      candidateCount: 1,
      candidates: [{ rank: 1, url: "https://example.com/docs?a=1&b=2" }],
    });

    const resolution = invocation("source_resolution", "resolve", {
      schemaVersion: "knowledge.source-resolution/v1",
      candidates: [
        { candidateId: "paper", identifierKind: "doi", identifier: "https://doi.org/10.1000/ABC" },
        { candidateId: "docs", identifierKind: "url", identifier: "https://EXAMPLE.com/docs?b=2&a=1#x" },
      ],
    });
    await expect(registry.execute(resolution.operation, resolution.claim)).resolves.toMatchObject({
      resolvedCount: 2,
      resolved: [
        { candidateId: "docs", canonicalIdentifier: "https://example.com/docs?a=1&b=2" },
        { candidateId: "paper", canonicalIdentifier: "doi:10.1000/abc" },
      ],
    });

    const representationId = uuid(),
      nodeId = uuid(),
      nodes = [documentNode(representationId, nodeId, "Durable agents use fenced leases and receipts.")];
    const preview = invocation("chunk_preview", "preview", {
      schemaVersion: "knowledge.chunk-preview/v1",
      nodes,
      profileName: "heading-sections-v1",
      profileVersion: "1.0.0",
    });
    await expect(registry.execute(preview.operation, preview.claim)).resolves.toMatchObject({
      persisted: false,
      chunks: [{ ordinal: 0 }],
    });
    const comparison = invocation("chunk_comparison", "compare", {
      schemaVersion: "knowledge.chunk-comparison/v1",
      nodes,
      profiles: [
        { name: "heading-sections-v1", version: "1.0.0" },
        { name: "atomic-claims-v1", version: "1.0.0" },
      ],
    });
    await expect(registry.execute(comparison.operation, comparison.claim)).resolves.toMatchObject({
      variants: [{ profile: { name: "heading-sections-v1" } }, { profile: { name: "atomic-claims-v1" } }],
    });

    const rightRepresentationId = uuid(),
      rightNodeId = uuid(),
      representationComparison = invocation("representation_comparison", "compare", {
        schemaVersion: "knowledge.representation-comparison/v1",
        left: { representationId, digest: sha256Digest("left"), nodes },
        right: {
          representationId: rightRepresentationId,
          digest: sha256Digest("right"),
          nodes: [documentNode(rightRepresentationId, rightNodeId, "Durable agents use immutable receipts.")],
        },
      });
    await expect(
      registry.execute(representationComparison.operation, representationComparison.claim),
    ).resolves.toMatchObject({
      identical: false,
      addedAlignmentKeys: [],
      removedAlignmentKeys: [],
      changedNodes: [{ leftNodeId: nodeId, rightNodeId }],
    });
    const identicalComparison = invocation("representation_comparison", "compare", {
      schemaVersion: "knowledge.representation-comparison/v1",
      left: { representationId, digest: sha256Digest("same"), nodes },
      right: {
        representationId: rightRepresentationId,
        digest: sha256Digest("same"),
        nodes: [documentNode(rightRepresentationId, rightNodeId, nodes[0]!.text)],
      },
    });
    await expect(registry.execute(identicalComparison.operation, identicalComparison.claim)).resolves.toMatchObject({
      identical: true,
      addedAlignmentKeys: [],
      removedAlignmentKeys: [],
      changedNodes: [],
    });

    const dataset = {
      id: "experiment-dataset",
      version: 1,
      name: "Experiment dataset",
      reviewed: false,
      reviewMode: "development" as const,
      cases: [
        {
          id: "case-1",
          query: "durable activity",
          domain: "engineering_claims" as const,
          queryClass: "semantic" as const,
          provenance: ["fixture"],
          relevanceJudgments: [{ recordId: "record-1", grade: 3 as const, rationale: "exact fixture" }],
        },
      ],
    };
    const output = {
      caseId: "case-1",
      items: [{ recordId: "record-1", rank: 1, score: 1 }],
      abstained: false,
      latencyMs: 1,
      costMicros: 0,
    };
    const experiment = invocation("experiment", "record", {
      schemaVersion: "knowledge.experiment/v1",
      id: "experiment-1",
      hypothesis: "candidate equals control",
      dataset,
      k: 10,
      arms: [
        { id: "control", name: "Control", control: true, configuration: { version: "a" }, outputs: [output] },
        { id: "candidate", name: "Candidate", control: false, configuration: { version: "b" }, outputs: [output] },
      ],
    });
    await expect(registry.execute(experiment.operation, experiment.claim)).resolves.toMatchObject({
      comparisons: [{ armId: "candidate", recallAtKDelta: 0, ndcgAtKDelta: 0 }],
    });
  });

  it("executes a sealed capture through structural conversion and reconstructable candidate chunks", async () => {
    const durable = preparationFixture();
    const dependencies = {
      ...productionDependencies(),
      durablePreparation: {
        ...durable,
        sourceStorageBucket: "source-captures" as const,
        derivativeStorageBucket: "content-derivatives" as const,
      },
    };
    const registry = createProductionActivityRegistry(dependencies);
    const captureInput = {
      schemaVersion: "knowledge.capture/v1",
      source: {
        sourceClass: "web_page",
        canonicalUrl: "https://example.com/durable-agents",
        publisher: "Example",
        sensitivity: "public",
      },
      request: {
        purpose: "prepare durable agent guidance",
        target: { kind: "http", url: "https://example.com/durable-agents" },
        expectedSourceClass: "web_page",
        preferredMediaTypes: ["text/markdown"],
        egressProfile: "public-web-v1",
        maximumBytes: 100_000,
        renderingPolicy: "none",
        interactionPolicy: "none",
        classification: "public",
        expectedOutputs: ["source_capture"],
      },
    };
    const captureRun = invocation("capture", "acquire", captureInput);
    const acquired = (await registry.execute(captureRun.operation, captureRun.claim)) as Record<string, unknown>;
    expect(acquired).toMatchObject({ schemaVersion: "knowledge.capture-result/v1", verification: { accepted: true } });
    await expect(registry.execute(captureRun.operation, captureRun.claim)).resolves.toEqual(acquired);
    await expect(registry.execute(captureRun.operation, stepClaim(captureRun, "seal", 1))).resolves.toMatchObject({
      byteIdentityVerified: true,
    });

    const transformationInput = {
      schemaVersion: "knowledge.transformation/v1",
      captureOperationId: captureRun.operation.id,
      document: {
        documentKind: "official_docs",
        canonicalTitle: "Durable agents",
        versionLabel: "fixture-v1",
        identifier: { type: "url", value: "https://example.com/durable-agents" },
      },
      profile: {
        profileKey: "deterministic-markdown",
        version: "1.0.0",
        mediaType: "text/markdown",
        managedProcessingAllowed: false,
      },
      providerRoute: ["deterministic-structural-text"],
      a2a: {
        taskId: uuid(),
        kind: "document_preparation",
        purpose: "prepare the captured fixture",
        inputArtifactIds: [],
        expectedOutputContract: "knowledge.representation/v1",
        callback: {
          url: "https://eve.example/callback",
          authenticationReference: "secret://callback-auth",
          signingKeyReference: "secret://callback-signing",
        },
      },
    };
    const transformationRun = invocation("transformation", "convert", transformationInput, captureRun.context.tenantId);
    const converted = (await registry.execute(transformationRun.operation, transformationRun.claim)) as Record<
      string,
      unknown
    >;
    expect(converted).toMatchObject({
      schemaVersion: "knowledge.transformation-result/v1",
      requiresReview: true,
      nodeCount: 2,
    });
    await expect(registry.execute(transformationRun.operation, transformationRun.claim)).resolves.toEqual(converted);
    await expect(
      registry.execute(transformationRun.operation, stepClaim(transformationRun, "inspect", 1)),
    ).resolves.toMatchObject({
      artifactDigestVerified: true,
      requiresReview: true,
      publishable: false,
    });

    const representationId = String(converted.structuralRepresentationId);
    const chunkInput = {
      schemaVersion: "knowledge.chunk-set/v1",
      representationId,
      profileName: "heading-sections-v1",
      profileVersion: "1.0.0",
    };
    const chunkRun = invocation("chunk_set", "chunk", chunkInput, captureRun.context.tenantId);
    const firstChunk = await registry.execute(chunkRun.operation, chunkRun.claim);
    expect(firstChunk).toMatchObject({ chunkCount: expect.any(Number), status: "succeeded" });
    await expect(registry.execute(chunkRun.operation, chunkRun.claim)).resolves.toEqual(firstChunk);
    await expect(registry.execute(chunkRun.operation, stepClaim(chunkRun, "verify", 1))).resolves.toMatchObject({
      reconstructable: true,
      promotionState: "candidate",
      publishable: false,
    });
    expect(durable.repository.persistCapture).toHaveBeenCalledOnce();
    expect(durable.repository.persistRepresentation).toHaveBeenCalledOnce();
    expect(durable.repository.persistChunkSet).toHaveBeenCalledOnce();
    expect(dependencies.review.createReviewSubject).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ subjectKind: "conversion" }),
    );
  });

  it("rejects unversioned preparation input before any side effect", async () => {
    const durable = preparationFixture();
    const registry = createProductionActivityRegistry({
      ...productionDependencies(),
      durablePreparation: {
        ...durable,
        sourceStorageBucket: "source-captures",
        derivativeStorageBucket: "content-derivatives",
      },
    });
    const run = invocation("capture", "acquire", { url: "https://example.com" });
    await expect(registry.execute(run.operation, run.claim)).rejects.toMatchObject({
      code: "INVALID_ACTIVITY_INPUT",
      retryable: false,
    });
    expect(durable.repository.persistCapture).not.toHaveBeenCalled();
  });

  it("accepts an attested local upload target and still seals one artifact", async () => {
    const artifacts = new InMemoryArtifactStore();
    const durable = preparationFixture();
    const acquisition = new FixtureAcquisitionAdapter("manual-upload", "upload", artifacts, {
      normalizedTarget: "upload:notes",
      mediaType: "text/plain",
      bytes: new TextEncoder().encode("operator file"),
      observations: { origin: "operator" },
      identifiers: ["upload:notes"],
    });
    const registry = createProductionActivityRegistry({
      ...productionDependencies(),
      durablePreparation: {
        ...durable,
        acquisition,
        sourceStorageBucket: "source-captures",
        derivativeStorageBucket: "content-derivatives",
      },
    });
    const captureInput = {
      schemaVersion: "knowledge.capture/v1",
      source: {
        sourceClass: "other",
        canonicalUrl: "file://operator/notes.txt",
        publisher: "Operator",
        sensitivity: "public",
      },
      request: {
        purpose: "prepare a local fixture",
        target: { kind: "upload", uploadId: "notes", declaredOrigin: "operator" },
        expectedSourceClass: "other",
        preferredMediaTypes: ["text/plain"],
        egressProfile: "public-web-v1",
        maximumBytes: 100_000,
        renderingPolicy: "none",
        interactionPolicy: "none",
        classification: "public",
        expectedOutputs: ["source_capture"],
      },
    };
    const captureRun = invocation("capture", "acquire", captureInput);
    await expect(registry.execute(captureRun.operation, captureRun.claim)).resolves.toMatchObject({
      schemaVersion: "knowledge.capture-result/v1",
      verification: { accepted: true },
    });
    expect(durable.repository.persistCapture).toHaveBeenCalledOnce();
  });

  it("rejects an HTTP capture whose canonical URL does not match the target", async () => {
    const durable = preparationFixture();
    const registry = createProductionActivityRegistry({
      ...productionDependencies(),
      durablePreparation: {
        ...durable,
        sourceStorageBucket: "source-captures",
        derivativeStorageBucket: "content-derivatives",
      },
    });
    const run = invocation("capture", "acquire", {
      schemaVersion: "knowledge.capture/v1",
      source: {
        sourceClass: "web_page",
        canonicalUrl: "https://example.com/other",
        sensitivity: "public",
      },
      request: {
        purpose: "prepare",
        target: { kind: "http", url: "https://example.com/durable-agents" },
        expectedSourceClass: "web_page",
        preferredMediaTypes: ["text/markdown"],
        egressProfile: "public-web-v1",
        maximumBytes: 1000,
        renderingPolicy: "none",
        interactionPolicy: "none",
        classification: "public",
        expectedOutputs: ["source_capture"],
      },
    });
    await expect(registry.execute(run.operation, run.claim)).rejects.toMatchObject({
      code: "INVALID_ACTIVITY_INPUT",
      retryable: false,
    });
    expect(durable.repository.persistCapture).not.toHaveBeenCalled();
  });

  it("performs deterministic source vetting without publishing or embedding", async () => {
    const dependencies = productionDependencies();
    const registry = createProductionActivityRegistry(dependencies);
    const bundle = {
      schema_version: "ai-engineer-embedding-bundle/0.1.0",
      store_class: "internal_exploratory",
      video_id: "worker-fixture",
      title: "Worker fixture",
      research_as_of: "2026-09-04",
      primary: {
        engineer: { slug: "engineer", display_name: "Engineer" },
        organization: { slug: "organization", display_name: "Organization" },
      },
      selected_documents: [
        {
          id: "document-1",
          document_kind: "official_docs",
          title: "Durable agents",
          canonical_url: "https://example.com/durable-agents",
          source_role: "official",
          publisher: "Example",
          source_class: "documentation",
          target_vector_spaces: ["engineering_claims"],
          text: "Durable activities need idempotency and fenced leases.",
          entity_slugs: ["organization"],
        },
      ],
      engineering_claims: [],
    };
    const { operation, claim } = invocation("source_vetting", "vet", bundle);

    const result = (await registry.execute(operation, claim)) as Record<string, unknown>;
    const retried = (await registry.execute(operation, claim)) as Record<string, unknown>;
    expect(result.accepted).toBe(true);
    expect(retried).toEqual(result);
    expect(result.proposals).toEqual([
      expect.objectContaining({ requestedAuthority: "reviewer_decision", state: "submitted" }),
    ]);
    expect(result.reviewSubjectId).toEqual(expect.any(String));
    expect(dependencies.review.createReviewSubject).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ subjectKind: "source_vetting", eligibleRoles: ["human_reviewer"] }),
    );
    expect(dependencies.review.createReviewSubject).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({ id: result.reviewSubjectId }),
    );
  });

  it("executes and receipts exact-versus-ANN verification inputs", async () => {
    const retrieval = retrievalDependencies();
    const registry = createProductionActivityRegistry({ retrieval, review: productionDependencies().review });
    const input = {
      vectorSpaceVersionId: uuid(),
      queryEmbedding: Array.from({ length: 1_536 }, (_, index) => index / 1_536),
      resultLimit: 2,
      minimumRecallAtK: 1,
    };
    const { operation, claim, context } = invocation("publication_verification", "verify", input);

    await expect(registry.execute(operation, claim)).resolves.toMatchObject({
      overlapCount: 2,
      recallAtK: 1,
      passed: true,
    });
    expect(retrieval.annNearest).toHaveBeenCalledWith(expect.objectContaining({ tenantId: context.tenantId }));
    expect(retrieval.exactNearest).toHaveBeenCalledOnce();
  });

  it("freezes a development dataset and runs both durable evaluation steps", async () => {
    const registry = createProductionActivityRegistry(productionDependencies());
    const dataset = {
      id: "worker-evaluation",
      version: 1,
      name: "Worker evaluation",
      reviewed: false,
      reviewMode: "development",
      cases: [
        {
          id: "case-1",
          query: "durable activity",
          domain: "engineering_claims",
          queryClass: "semantic",
          provenance: ["fixture"],
          relevanceJudgments: [{ recordId: "record-1", grade: 3, rationale: "exact fixture" }],
        },
      ],
    };
    const frozen = invocation("evaluation_dataset", "freeze", dataset);
    await expect(registry.execute(frozen.operation, frozen.claim)).resolves.toMatchObject({ frozen: true });

    const evaluationInput = {
      dataset,
      outputs: [
        {
          caseId: "case-1",
          items: [{ recordId: "record-1", rank: 1, score: 1 }],
          abstained: false,
          latencyMs: 1,
          costMicros: 0,
        },
      ],
      k: 10,
    };
    for (const [ordinal, stepName] of ["evaluate", "report"].entries()) {
      const run = invocation("evaluation_run", stepName, evaluationInput);
      const input = { ...(run.claim.input as Record<string, unknown>), step: { name: stepName, ordinal } };
      const claim = { ...run.claim, input, inputSha256: digestHex(input) };
      await expect(registry.execute(run.operation, claim)).resolves.toMatchObject({
        stage: stepName,
        report: { overall: { recallAtK: 1, falseAcceptanceCount: 0 } },
      });
    }
  });
});
