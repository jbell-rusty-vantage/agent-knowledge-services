import { describe, expect, it } from "vitest";
import {
  ArtifactResourceSchema,
  DocumentRepresentationSchema,
  DurableReceiptResourceSchema,
  ModelAuthoredProposalSchema,
  PromotionDecisionSchema,
  RetrievalPlanSchema,
  RetrievalRunInputSchema,
  ServiceIdentitySchema,
  VectorSpaceSchema,
} from "./index.js";

const id = (digit: number) => `00000000-0000-4000-8000-${String(digit).padStart(12, "0")}`;
const digest = (digit: string) => `sha256:${digit.repeat(64)}`;
const createdAt = "2026-09-03T12:00:00Z";

describe("public contract surface", () => {
  it("defines the complete service identity and vector-space catalogs", () => {
    expect(ServiceIdentitySchema.options).toEqual([
      "knowledge_api",
      "knowledge_worker",
      "acquisition_executor",
      "conversion_executor",
      "inspection_agent",
      "content_curator_agent",
      "embedding_executor",
      "retrieval_executor",
      "evaluation_executor",
      "human_reviewer",
      "mission_control_client",
      "retention_worker",
      "control_plane",
    ]);
    expect(VectorSpaceSchema.options).toEqual([
      "engineering_claims",
      "tool_capabilities",
      "implementation_examples",
      "paper_case_study_knowledge",
      "entity_profiles",
      "model_capabilities",
      "benchmark_intelligence",
      "source_native_sections",
    ]);
  });

  it("rejects source-native labels without byte identity", () => {
    const candidate = {
      id: id(1),
      tenantId: id(2),
      digest: digest("a"),
      schemaVersion: "v1",
      createdAt,
      documentVersionId: id(3),
      artifact: { artifactId: id(4), tenantId: id(2), digest: digest("a"), mediaType: "text/html" },
      representationClass: "source_native",
      representationKind: "html",
      mediaType: "text/html",
      fidelity: "faithful",
      sourceNativeByteIdentity: false,
      acceptanceState: "candidate",
    };
    expect(DocumentRepresentationSchema.safeParse(candidate).success).toBe(false);
  });

  it("keeps model proposals separate from decisions", () => {
    const proposal = {
      id: id(1),
      tenantId: id(2),
      digest: digest("a"),
      schemaVersion: "v1",
      createdAt,
      proposalType: "promotion",
      proposalStage: "vector_space_promotion",
      correlationId: "corr-1",
      inputArtifactDigests: [digest("b")],
      inputRepresentationDigests: [digest("c")],
      proposedAction: "Promote",
      selectedDomains: ["engineering_claims"],
      targetContract: "claim.v1",
      rationale: "Evidence supports the claim",
      supportingLocators: [],
      canonicalReferences: [],
      uncertainty: [],
      unresolvedQuestions: [],
      alternativesConsidered: ["reject"],
      requestedReviewClass: "official",
      author: {
        kind: "model",
        id: id(5),
        serviceIdentity: "content_curator_agent",
        model: "model-1",
        providerRunId: "run-1",
      },
      promptDigest: digest("d"),
      capabilityProfileVersion: "curator@1",
    };
    expect(ModelAuthoredProposalSchema.parse(proposal).author.kind).toBe("model");
    expect(
      PromotionDecisionSchema.safeParse({
        ...proposal,
        proposalId: id(1),
        stage: "vector_space_promotion",
        guardedProposalDigest: digest("a"),
        decision: "accept",
        targetState: "approved",
        gateResultIds: [id(6)],
        decider: proposal.author,
        policyVersionId: id(7),
        separationOfDutyEvidence: "separate",
        expiresAt: undefined,
      }).success,
    ).toBe(false);
  });

  it("validates retrieval bounds and decomposition identity", () => {
    const plan = {
      policyVersion: id(1),
      query: "typescript agents",
      intents: ["implementation_lookup"],
      subqueries: [{ id: "q1", text: "implementation", coverageRole: "required" }],
      spaces: ["implementation_examples"],
      anchors: { entities: [], concepts: [], useCases: [] },
      hardFilters: [{ field: "language", op: "eq", value: "typescript" }],
      softBoosts: [],
      temporalScope: {},
      candidateK: 50,
      finalK: 10,
      graph: { maxDepth: 1, allowedEdges: [] },
      abstention: { minimumCoverage: 1 },
    };
    expect(RetrievalPlanSchema.parse(plan).finalK).toBe(10);
    expect(RetrievalPlanSchema.safeParse({ ...plan, candidateK: 5, finalK: 10 }).success).toBe(false);
    expect(RetrievalPlanSchema.safeParse({ ...plan, unexpected: true }).success).toBe(false);
    expect(RetrievalRunInputSchema.safeParse({ plan, queryEmbedding: [0, 1] }).success).toBe(false);
  });

  it("keeps addressed artifact and durable receipt digests internally consistent", () => {
    expect(
      ArtifactResourceSchema.parse({
        artifactId: id(1),
        tenantId: id(2),
        artifactType: "source_capture",
        schemaVersion: 1,
        digest: digest("a"),
        bucketClass: "source_captures",
        mediaType: "text/plain",
        byteLength: 12,
        createdAt,
      }).artifactId,
    ).toBe(id(1));
    const receipt = {
      id: id(3),
      tenantId: id(2),
      operationId: id(4),
      stepId: id(5),
      receiptKind: "capture.succeeded",
      idempotencyKey: "receipt-test",
      executorIdentity: "worker:test",
      inputSha256: "b".repeat(64),
      inputDigest: digest("b"),
      outputSha256: "c".repeat(64),
      outputDigest: digest("c"),
      outcome: "succeeded",
      body: { artifactId: id(1) },
      createdAt,
    };
    expect(DurableReceiptResourceSchema.parse(receipt).id).toBe(id(3));
    expect(DurableReceiptResourceSchema.safeParse({ ...receipt, outputDigest: digest("d") }).success).toBe(false);
  });
});
