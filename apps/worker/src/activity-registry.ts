import {
  KNOWLEDGE_OPERATION_REQUEST_SCHEMA_VERSION,
  KnowledgePreparationService,
  verificationOwnedOperationKinds,
  type VettedBundleInput,
} from "@aiengineer/knowledge-application";
import type { AcquisitionAdapter, AcquisitionRequest } from "@aiengineer/knowledge-acquisition";
import { normalizePaperIdentifier } from "@aiengineer/knowledge-acquisition";
import { chunkDocument, defaultChunkProfileRegistry } from "@aiengineer/knowledge-preparation";
import {
  A2AOperationBindingSchema,
  DocumentNodeSchema,
  EvidencePacketSchema,
  JsonValueSchema,
  OperationContextSchema,
  OperationKindSchema,
  PromotionProposalInputSchema,
  SelectedCandidateEvaluationInputSchema,
  SelectedCandidateIndexInputSchema,
  VectorStoreCreateInputSchema,
  VectorStoreDocumentsInputSchema,
  VectorStoreIngestionInputSchema,
  type JsonValue,
  type OperationKind,
} from "@aiengineer/knowledge-contracts";
import {
  conversionRouterFromProviders,
  type ConversionNode,
  type ConversionProfile,
  type ConversionRoutingReceipt,
  type DocumentConversionProvider,
} from "@aiengineer/knowledge-preparation";
import { sha256Digest } from "@aiengineer/knowledge-core";
import type { EmbeddingAdapter } from "@aiengineer/knowledge-retrieval";
import { convertStructuralDocument, verifyNodeLocators, type StructuralBlock } from "@aiengineer/knowledge-preparation";
import { deterministicUuid } from "@aiengineer/knowledge-core";
import {
  evaluateRetrieval,
  createExperimentMatrix,
  freezeEvaluationDataset,
  type EvaluationCaseOutput,
  type EvaluationDatasetInput,
} from "@aiengineer/knowledge-evaluation";
import type {
  CanonicalOperationRecord,
  LeasedStep,
  OperationsRepository,
  ReviewRepository,
  RetrievalRepository,
  PreparationRepository,
  PersistedPreparationArtifact,
  GovernedIndexRepository,
  VectorStoreLifecycleRepository,
} from "@aiengineer/knowledge-persistence";
import { sameActorIdentity } from "@aiengineer/knowledge-persistence";
import { digestBytes, type ArtifactStore, type StoredArtifact } from "@aiengineer/knowledge-core";
import { z, ZodError } from "zod";

const durableStepInputSchema = z.strictObject({
  schemaVersion: z.literal(KNOWLEDGE_OPERATION_REQUEST_SCHEMA_VERSION),
  kind: OperationKindSchema,
  operationInput: JsonValueSchema,
  expectedVersions: z
    .record(z.string(), z.string().trim().min(1))
    .refine((versions) => Object.keys(versions).length > 0, "at least one expected contract version is required"),
  context: OperationContextSchema,
  step: z.strictObject({
    name: z.string().trim().min(1),
    ordinal: z.int().nonnegative(),
  }),
});

const durableOperationRequestSchema = z.strictObject({
  schemaVersion: z.literal(KNOWLEDGE_OPERATION_REQUEST_SCHEMA_VERSION),
  kind: OperationKindSchema,
  input: JsonValueSchema,
  authenticatedContext: OperationContextSchema.optional(),
  expectedVersions: z
    .record(z.string(), z.string().trim().min(1))
    .refine((versions) => Object.keys(versions).length > 0, "at least one expected contract version is required"),
});

const preparationDocumentSchema = z.strictObject({
  id: z.string().trim().min(1),
  document_kind: z.string().trim().min(1),
  title: z.string().trim().min(1),
  canonical_url: z.string(),
  source_role: z.enum(["official", "primary", "authoritative_secondary"]),
  publisher: z.string().trim().min(1),
  source_class: z.string().trim().min(1),
  target_vector_spaces: z.array(z.string()),
  text: z.string(),
  entity_slugs: z.array(z.string()),
});

const preparationClaimSchema = z.strictObject({
  id: z.string().trim().min(1),
  statement: z.string().trim().min(1),
  claim_role: z.string().trim().min(1),
  problem: z.string().optional(),
  mechanism: z.string().optional(),
  applicability: z.string().optional(),
  limitations: z.string().optional(),
  attribution: z.string().trim().min(1),
  locator_excerpt: z.string().trim().min(1),
  related_entities: z.array(z.string().trim().min(1)),
});

const vettedBundleSchema = z.strictObject({
  schema_version: z.literal("ai-engineer-embedding-bundle/0.1.0"),
  store_class: z.literal("internal_exploratory"),
  video_id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  research_as_of: z.iso.date(),
  primary: z.strictObject({
    engineer: z.strictObject({ slug: z.string().trim().min(1), display_name: z.string().trim().min(1) }),
    organization: z.strictObject({ slug: z.string().trim().min(1), display_name: z.string().trim().min(1) }),
  }),
  selected_documents: z.array(preparationDocumentSchema).min(1),
  engineering_claims: z.array(preparationClaimSchema),
});

const filterValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.union([z.string(), z.number(), z.boolean()])),
]);
const expectedFilterSchema = z.strictObject({
  field: z.string().trim().min(1),
  value: filterValueSchema,
});
const evaluationCaseSchema = z.strictObject({
  id: z.string().trim().min(1),
  query: z.string().trim().min(1),
  domain: z.enum([
    "engineering_claims",
    "tool_capabilities",
    "implementation_examples",
    "paper_case_study_knowledge",
    "entity_profiles",
    "model_capabilities",
    "benchmark_intelligence",
    "source_native_sections",
  ]),
  queryClass: z.enum([
    "semantic",
    "lexical",
    "filtered",
    "graph",
    "temporal",
    "exact",
    "conceptual",
    "mixed",
    "constraint",
    "multi_hop",
    "code",
    "contradiction",
    "freshness_temporal",
    "negative_abstention",
    "adversarial",
  ]),
  provenance: z.array(z.string().trim().min(1)).min(1),
  relevanceJudgments: z.array(
    z.strictObject({
      recordId: z.string().trim().min(1),
      grade: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
      rationale: z.string().trim().min(1),
    }),
  ),
  expectedFilters: z.array(expectedFilterSchema).optional(),
  expectedAbstain: z.boolean().optional(),
  partition: z.enum(["dev", "calibration", "heldout"]).optional(),
  sourceFamily: z.string().optional(),
  entityFamily: z.string().optional(),
  forbiddenResultIds: z.array(z.string()).optional(),
  forbiddenFilters: z.array(expectedFilterSchema).optional(),
  authorProvenance: z.string().optional(),
  reviewerProvenance: z.string().optional(),
  fixtureKind: z.enum(["real_bundle_grounded", "synthetic_gap", "reviewed_negative", "adversarial"]).optional(),
  expectedFacts: z.array(z.string()).optional(),
  expectedLocatorDigests: z.array(z.string()).optional(),
  requiredResultType: z.string().optional(),
  requiredResultTypes: z.array(z.string()).optional(),
  difficulty: z.enum(["easy", "medium", "hard"]).optional(),
  tags: z.array(z.string()).optional(),
  policySlice: z.string().optional(),
  expectedGraphPath: z.array(z.string()).optional(),
});
const evaluationReviewArtifactSchema = z.strictObject({
  candidateManifestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  authorIdentity: z.string().trim().min(1),
  reviewerIdentity: z.string().trim().min(1),
  decision: z.enum(["accept", "reject"]),
  reviewedCaseIds: z.array(z.string().trim().min(1)),
  reviewedAt: z.string().trim().min(1),
  rationale: z.string().trim().min(1),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
});
const evaluationDatasetInputSchema = z.strictObject({
  id: z.string().trim().min(1),
  version: z.int().positive(),
  name: z.string().trim().min(1),
  cases: z.array(evaluationCaseSchema).min(1),
  reviewed: z.boolean(),
  reviewMode: z.enum(["independent", "development"]).optional(),
  reviewArtifact: evaluationReviewArtifactSchema.optional(),
});
const evaluationOutputSchema = z.strictObject({
  caseId: z.string().trim().min(1),
  items: z.array(
    z.strictObject({
      recordId: z.string().trim().min(1),
      rank: z.int().positive(),
      score: z.number().finite(),
      matchedFilters: z.record(z.string(), filterValueSchema).optional(),
      citation: z.strictObject({ entailed: z.boolean(), locatorValid: z.boolean() }).optional(),
      resultType: z.string().optional(),
      locatorDigests: z.array(z.string()).optional(),
      graphPaths: z.array(z.array(z.string())).optional(),
      contentDigest: z
        .string()
        .regex(/^sha256:[a-f0-9]{64}$/)
        .optional(),
    }),
  ),
  abstained: z.boolean(),
  latencyMs: z.number().nonnegative(),
  costMicros: z.number().nonnegative(),
});

const evaluationRunInputSchema = z.strictObject({
  dataset: evaluationDatasetInputSchema,
  outputs: z.array(evaluationOutputSchema),
  k: z.int().positive().max(100).default(10),
});

const vectorVerificationInputSchema = z.strictObject({
  vectorSpaceVersionId: z.uuid(),
  queryEmbedding: z.array(z.number().finite()).length(1_536),
  resultLimit: z.int().positive().max(100).default(20),
  minimumRecallAtK: z.number().min(0).max(1).default(0.95),
});

const evidencePacketInputSchema = z.strictObject({
  planId: z.uuid(),
  runId: z.uuid(),
  packetId: z.uuid(),
  packet: EvidencePacketSchema,
  a2a: A2AOperationBindingSchema.optional(),
});

const captureInputSchema = z
  .strictObject({
    schemaVersion: z.literal("knowledge.capture/v1"),
    source: z.strictObject({
      sourceClass: z.enum(["web_page", "api", "repository", "pdf", "transcript", "dataset", "registry", "other"]),
      canonicalUrl: z.url(),
      publisher: z.string().trim().min(1).optional(),
      sensitivity: z.enum(["public", "restricted", "confidential"]),
    }),
    request: z.strictObject({
      purpose: z.string().trim().min(1),
      target: z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("http"), url: z.url() }),
        z.strictObject({
          kind: z.literal("upload"),
          uploadId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
          declaredOrigin: z.string().trim().min(1),
        }),
      ]),
      expectedSourceClass: z.string().trim().min(1),
      preferredMediaTypes: z.array(z.string().trim().min(1)).min(1),
      egressProfile: z.literal("public-web-v1"),
      maximumBytes: z.int().positive().max(1_073_741_824),
      renderingPolicy: z.enum(["none", "allowed", "required"]),
      interactionPolicy: z.enum(["none", "bounded"]),
      classification: z.enum(["public", "restricted", "confidential"]),
      expectedOutputs: z.array(z.string().trim().min(1)).min(1),
    }),
  })
  .superRefine((value, context) => {
    if (
      value.request.target.kind === "http" &&
      new URL(value.source.canonicalUrl).href !== new URL(value.request.target.url).href
    ) {
      context.addIssue({
        code: "custom",
        message: "source canonical URL must equal the exact capture target",
        path: ["source", "canonicalUrl"],
      });
    }
    if (value.source.sensitivity !== value.request.classification) {
      context.addIssue({
        code: "custom",
        message: "source sensitivity must equal capture classification",
        path: ["source", "sensitivity"],
      });
    }
  });

const transformationInputSchema = z.strictObject({
  schemaVersion: z.literal("knowledge.transformation/v1"),
  captureOperationId: z.uuid(),
  document: z.strictObject({
    documentKind: z.string().trim().min(1),
    canonicalTitle: z.string().trim().min(1),
    versionLabel: z.string().trim().min(1),
    identifier: z
      .strictObject({
        type: z.enum(["url", "doi", "arxiv", "openreview", "isbn", "repository", "media_id", "other"]),
        value: z.string().trim().min(1),
        authority: z.string().trim().min(1).optional(),
      })
      .optional(),
  }),
  profile: z.strictObject({
    profileKey: z.string().trim().min(1),
    version: z.string().trim().min(1),
    mediaType: z.string().trim().min(1),
    language: z.string().trim().min(1).optional(),
    preserveHtml: z.boolean().optional(),
    managedProcessingAllowed: z.boolean(),
    maximumPolls: z.int().positive().max(10_000).optional(),
  }),
  providerRoute: z.array(z.string().trim().min(1)).min(1),
  a2a: A2AOperationBindingSchema.optional(),
});

const chunkSetInputSchema = z.strictObject({
  schemaVersion: z.literal("knowledge.chunk-set/v1"),
  representationId: z.uuid(),
  profileName: z.string().trim().min(1),
  profileVersion: z.string().trim().min(1),
});

const sourceDiscoveryInputSchema = z.strictObject({
  schemaVersion: z.literal("knowledge.source-discovery/v1"),
  query: z.string().trim().min(1).max(2_000),
  candidates: z
    .array(
      z.strictObject({
        url: z.url().max(4_096),
        title: z.string().trim().min(1).max(500),
        sourceClass: z.string().trim().min(1).max(100),
        publisher: z.string().trim().min(1).max(300).optional(),
        score: z.number().finite().min(0).max(1),
        evidence: z.array(z.string().trim().min(1).max(1_000)).max(16),
      }),
    )
    .max(500),
  limit: z.int().positive().max(100).default(25),
});

const sourceResolutionInputSchema = z.strictObject({
  schemaVersion: z.literal("knowledge.source-resolution/v1"),
  candidates: z
    .array(
      z.strictObject({
        candidateId: z.string().trim().min(1).max(255),
        identifierKind: z.enum(["url", "doi", "arxiv", "openreview"]),
        identifier: z.string().trim().min(1).max(4_096),
      }),
    )
    .min(1)
    .max(500),
});

const chunkPreviewInputSchema = z.strictObject({
  schemaVersion: z.literal("knowledge.chunk-preview/v1"),
  nodes: z.array(DocumentNodeSchema).min(1).max(10_000),
  profileName: z.string().trim().min(1).max(255),
  profileVersion: z.string().trim().min(1).max(100),
});

const chunkComparisonInputSchema = z.strictObject({
  schemaVersion: z.literal("knowledge.chunk-comparison/v1"),
  nodes: z.array(DocumentNodeSchema).min(1).max(10_000),
  profiles: z
    .array(z.strictObject({ name: z.string().trim().min(1).max(255), version: z.string().trim().min(1).max(100) }))
    .min(2)
    .max(12),
});

const representationComparisonInputSchema = z.strictObject({
  schemaVersion: z.literal("knowledge.representation-comparison/v1"),
  left: z.strictObject({
    representationId: z.uuid(),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    nodes: z.array(DocumentNodeSchema).max(10_000),
  }),
  right: z.strictObject({
    representationId: z.uuid(),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    nodes: z.array(DocumentNodeSchema).max(10_000),
  }),
});

const experimentInputSchema = z.strictObject({
  schemaVersion: z.literal("knowledge.experiment/v1"),
  id: z.string().trim().min(1).max(255),
  hypothesis: z.string().trim().min(1).max(2_000),
  dataset: evaluationDatasetInputSchema,
  k: z.int().positive().max(100).default(10),
  arms: z
    .array(
      z.strictObject({
        id: z.string().trim().min(1).max(255),
        name: z.string().trim().min(1).max(255),
        control: z.boolean(),
        configuration: JsonValueSchema,
        outputs: z.array(evaluationOutputSchema),
      }),
    )
    .min(2)
    .max(20),
});
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const typedDigest = (value: string) => value as `sha256:${string}`;
const representationDecisionInputSchema = z.strictObject({
  schemaVersion: z.literal("knowledge.representation-decision/v1"),
  representationId: z.uuid(),
  reviewSubjectId: z.uuid(),
  guardedDigest: digestSchema,
  decision: z.enum(["accept", "reject", "quarantine", "defer", "request_changes"]),
  policyVersion: z.string().trim().min(1),
  rationale: z.string().trim().min(1),
  expiresAt: z.iso.datetime().optional(),
});
const promotionDecisionInputSchema = z.strictObject({
  schemaVersion: z.literal("knowledge.promotion-decision/v1"),
  proposalId: z.uuid(),
  reviewSubjectId: z.uuid(),
  guardedDigest: digestSchema,
  decision: z.enum(["accept", "reject", "defer", "request_changes"]),
  gates: JsonValueSchema,
  policyVersion: z.string().trim().min(1),
  rationale: z.string().trim().min(1),
  expiresAt: z.iso.datetime().optional(),
});
const reviewDecisionInputSchema = z.strictObject({
  schemaVersion: z.literal("knowledge.review-decision/v1"),
  reviewSubjectId: z.uuid(),
  guardedDigest: digestSchema,
  decision: z.enum(["approve", "reject", "defer", "request_changes"]),
  rationale: z.string().trim().min(1).max(8_000),
});
const embeddingRunInputSchema = z.strictObject({
  schemaVersion: z.literal("knowledge.embedding-run/v1"),
  vectorSpaceVersionId: z.uuid(),
  promotionDecisionId: z.uuid(),
  projectionIds: z.array(z.uuid()).min(1),
  providerRoute: z.array(z.string().trim().min(1)).min(1),
  expectedDimensions: z.literal(1536),
  modelSlug: z.string().trim().min(1),
});
const baselineQuerySchema = z.strictObject({
  queryId: z.string().trim().min(1).max(256),
  embedding: z.array(z.number().finite()).length(1_536),
});
const spacePublicationInputSchema = z.strictObject({
  schemaVersion: z.literal("knowledge.space-publication/v1"),
  vectorStoreSpaceId: z.uuid(),
  vectorSpaceVersionId: z.uuid(),
  promotionDecisionId: z.uuid(),
  evaluationResultId: z.uuid(),
  expectedOwnerIdentity: z.string().trim().min(1),
  guardedDigest: digestSchema,
  reason: z.string().trim().min(1),
  /** Present whenever the space publishes an evaluated selected candidate rather than the legacy counted chain. */
  candidate: SelectedCandidateIndexInputSchema.optional(),
  candidateEvidenceDigest: digestSchema.optional(),
  evaluationDigest: digestSchema.optional(),
});
const publicationRollbackInputSchema = z.strictObject({
  schemaVersion: z.literal("knowledge.publication-rollback/v1"),
  currentPublicationId: z.uuid(),
  targetPublicationId: z.uuid(),
  guardedDigest: digestSchema,
  reason: z.string().trim().min(1),
  vectorStoreSpaceId: z.uuid().optional(),
  baselineQueries: z.array(baselineQuerySchema).min(1).max(16).optional(),
});

export interface DurableStepInput extends z.infer<typeof durableStepInputSchema> {}

export interface CanonicalActivityInvocation {
  readonly operation: CanonicalOperationRecord;
  readonly claim: LeasedStep;
  readonly activity: DurableStepInput;
}

export interface CanonicalActivityHandler {
  readonly operationKind: OperationKind;
  readonly stepName: string;
  execute(invocation: CanonicalActivityInvocation): unknown | Promise<unknown>;
}

export class CanonicalActivityError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CanonicalActivityError";
  }
}

const handlerKey = (operationKind: OperationKind, stepName: string) => `${operationKind}:${stepName}`;

/**
 * Fail-closed dispatcher for durable activities. Registration is keyed by both
 * the immutable operation kind and step name so similarly named steps cannot
 * cross an authority boundary.
 */
export class CanonicalActivityRegistry {
  readonly #handlers = new Map<string, CanonicalActivityHandler>();

  constructor(handlers: readonly CanonicalActivityHandler[]) {
    for (const handler of handlers) {
      const key = handlerKey(handler.operationKind, handler.stepName);
      if (this.#handlers.has(key)) throw new Error(`DUPLICATE_ACTIVITY_HANDLER:${key}`);
      this.#handlers.set(key, handler);
    }
  }

  activities(): readonly string[] {
    return Object.freeze([...this.#handlers.keys()].sort());
  }

  operationKinds(): readonly OperationKind[] {
    return Object.freeze([...new Set([...this.#handlers.values()].map((handler) => handler.operationKind))].sort());
  }

  parseInvocation(operation: CanonicalOperationRecord, claim: LeasedStep): CanonicalActivityInvocation {
    try {
      if (claim.input === undefined) {
        throw new CanonicalActivityError(
          "ACTIVITY_INPUT_MISSING",
          `Durable step ${claim.id} has no persisted input`,
          false,
        );
      }
      const persistedStepInput = JsonValueSchema.parse(claim.input);
      if (sha256Digest(persistedStepInput).slice(7) !== claim.inputSha256) {
        throw new CanonicalActivityError(
          "ACTIVITY_INPUT_DIGEST_MISMATCH",
          "Persisted activity input does not match its guarded digest",
          false,
        );
      }
      const activity = durableStepInputSchema.parse(claim.input);
      const request = durableOperationRequestSchema.parse(operation.request);
      if (
        (verificationOwnedOperationKinds as readonly string[]).includes(activity.kind) &&
        (!request.authenticatedContext ||
          sha256Digest(JsonValueSchema.parse(request.authenticatedContext)) !==
            sha256Digest(JsonValueSchema.parse(activity.context)))
      ) {
        throw new CanonicalActivityError(
          "ACTIVITY_AUTHENTICATED_CONTEXT_MISMATCH",
          "Verification step does not match its sealed authenticated context",
          false,
        );
      }
      if (sha256Digest(JsonValueSchema.parse(operation.request)).slice(7) !== operation.requestSha256) {
        throw new CanonicalActivityError(
          "ACTIVITY_REQUEST_DIGEST_MISMATCH",
          "Persisted operation request does not match its guarded digest",
          false,
        );
      }
      if (operation.id !== claim.operationId || operation.tenantId !== claim.tenantId) {
        throw new CanonicalActivityError(
          "ACTIVITY_OPERATION_IDENTITY_MISMATCH",
          "Claim is not bound to the loaded operation",
          false,
        );
      }
      if (activity.kind !== operation.operationKind) {
        throw new CanonicalActivityError(
          "ACTIVITY_OPERATION_KIND_MISMATCH",
          "Persisted step kind does not match its operation",
          false,
        );
      }
      if (
        request.kind !== activity.kind ||
        sha256Digest(request.input) !== sha256Digest(activity.operationInput) ||
        sha256Digest(request.expectedVersions) !== sha256Digest(activity.expectedVersions)
      ) {
        throw new CanonicalActivityError(
          "ACTIVITY_REQUEST_MISMATCH",
          "Persisted step input does not match its operation request",
          false,
        );
      }
      if (
        activity.context.operationId !== operation.id ||
        activity.context.tenantId !== operation.tenantId ||
        activity.context.idempotencyKey !== operation.idempotencyKey
      ) {
        throw new CanonicalActivityError(
          "ACTIVITY_CONTEXT_MISMATCH",
          "Persisted activity context does not match its operation",
          false,
        );
      }
      if (activity.step.name !== claim.stepKey || activity.step.name !== claim.stepKind) {
        throw new CanonicalActivityError(
          "ACTIVITY_STEP_MISMATCH",
          "Persisted activity step does not match its lease",
          false,
        );
      }
      return { operation, claim, activity };
    } catch (error) {
      if (error instanceof CanonicalActivityError) throw error;
      if (error instanceof ZodError) {
        throw new CanonicalActivityError("INVALID_ACTIVITY_INPUT", "Persisted activity input is invalid", false, {
          cause: error,
        });
      }
      throw error;
    }
  }

  async execute(operation: CanonicalOperationRecord, claim: LeasedStep): Promise<JsonValue> {
    const invocation = this.parseInvocation(operation, claim);
    const key = handlerKey(invocation.activity.kind, invocation.activity.step.name);
    const handler = this.#handlers.get(key);
    if (!handler) {
      throw new CanonicalActivityError(
        "UNSUPPORTED_OPERATION_ACTIVITY",
        `UNSUPPORTED_OPERATION_ACTIVITY:${invocation.activity.kind}:${invocation.activity.step.name}`,
        false,
      );
    }
    try {
      return JsonValueSchema.parse(await handler.execute(invocation));
    } catch (error) {
      if (error instanceof CanonicalActivityError) throw error;
      if (error instanceof ZodError) {
        throw new CanonicalActivityError("INVALID_ACTIVITY_INPUT", `Invalid input for ${key}`, false, { cause: error });
      }
      throw error;
    }
  }
}

export interface ProductionActivityDependencies {
  readonly retrieval: Pick<RetrievalRepository, "annNearest" | "exactNearest" | "storeEvidencePacket">;
  readonly review: Pick<ReviewRepository, "createReviewSubject" | "recordReviewDecision">;
  readonly vectorStore?: VectorStoreLifecycleRepository;
  readonly preparation?: KnowledgePreparationService;
  readonly durablePreparation?: {
    readonly repository: PreparationRepository;
    readonly sourceArtifacts: ArtifactStore;
    readonly derivativeArtifacts: ArtifactStore;
    readonly sourceStorageBucket: "source-captures" | "ai-engineer-cloud-bucket";
    readonly derivativeStorageBucket: "content-derivatives" | "ai-engineer-cloud-bucket";
    readonly acquisition: AcquisitionAdapter;
    readonly conversionProviders: readonly DocumentConversionProvider[];
  };
  readonly governedIndex?: {
    readonly repository: GovernedIndexRepository;
    readonly embeddingAdapter: EmbeddingAdapter;
    readonly embeddingAdapterVersion: string;
  };
  /** Fully composed verification handlers. Omission keeps the new kinds unadmitted. */
  readonly verificationHandlers?: readonly CanonicalActivityHandler[];
}

function persistedArtifact(
  artifact: StoredArtifact,
  storageBucket: "source-captures" | "content-derivatives" | "ai-engineer-cloud-bucket",
  artifactType: string,
  bucketClass: PersistedPreparationArtifact["bucketClass"],
): PersistedPreparationArtifact {
  return {
    artifactId: artifact.artifactId,
    digest: artifact.digest,
    mediaType: artifact.mediaType,
    byteLength: artifact.byteLength,
    storageKey: artifact.storageKey,
    storageBucket,
    artifactType,
    bucketClass,
  };
}

const structuralKinds = new Set([
  "heading",
  "paragraph",
  "list",
  "table",
  "figure",
  "formula",
  "code_block",
  "citation",
  "transcript_segment",
]);
function structuralBlocks(nodes: readonly ConversionNode[]): StructuralBlock[] {
  const admitted = nodes.filter((node) => structuralKinds.has(node.kind));
  const admittedIds = new Set(admitted.map((node) => node.id));
  return admitted.map((node, ordinal) => ({
    localKey: node.id,
    ordinal,
    kind: node.kind as StructuralBlock["kind"],
    text: node.text,
    ...(node.label ? { role: node.label } : {}),
    ...(node.parentId && admittedIds.has(node.parentId) ? { parentKey: node.parentId } : {}),
    locator: {
      ...(Array.isArray(node.locator.sectionPath) ? { sectionPath: node.locator.sectionPath as string[] } : {}),
      ...(typeof node.locator.startTimeMs === "number" ? { startTimeMs: node.locator.startTimeMs } : {}),
      ...(typeof node.locator.endTimeMs === "number" ? { endTimeMs: node.locator.endTimeMs } : {}),
      ...(typeof node.locator.domPath === "string" ? { domPath: node.locator.domPath } : {}),
    },
  }));
}

function preparationHandlers(
  dependencies: NonNullable<ProductionActivityDependencies["durablePreparation"]>,
  review: Pick<ReviewRepository, "createReviewSubject">,
): CanonicalActivityHandler[] {
  const providers = new Map(dependencies.conversionProviders.map((provider) => [provider.providerKey, provider]));
  return [
    {
      operationKind: "capture",
      stepName: "acquire",
      async execute({ activity, operation }) {
        const input = captureInputSchema.parse(activity.operationInput);
        try {
          const existing = await dependencies.repository.getCaptureByOperation(activity.context.tenantId, operation.id);
          if (existing) {
            const bytes = await dependencies.sourceArtifacts.get(activity.context.tenantId, existing.artifact.digest);
            if (
              !bytes ||
              digestBytes(bytes) !== existing.artifact.digest ||
              bytes.byteLength !== existing.artifact.byteLength
            ) {
              throw new CanonicalActivityError(
                "CAPTURE_SEAL_VERIFICATION_FAILED",
                "Existing capture bytes failed replay verification",
                false,
              );
            }
            const recorded = existing.observations as { verification?: unknown; result?: unknown };
            return {
              schemaVersion: "knowledge.capture-result/v1",
              sourceId: existing.sourceId,
              captureId: existing.captureId,
              artifact: existing.artifact,
              contentDigests: [existing.artifact.digest],
              verification: recorded.verification ?? { accepted: true, checks: ["replay_digest"], findings: [] },
              observations: recorded.result ?? [],
              capturedAt: existing.capturedAt,
            };
          }
          const request: AcquisitionRequest = {
            tenantId: activity.context.tenantId,
            purpose: input.request.purpose,
            target: input.request.target,
            expectedSourceClass: input.request.expectedSourceClass,
            preferredMediaTypes: input.request.preferredMediaTypes,
            egressProfile: input.request.egressProfile,
            maximumBytes: input.request.maximumBytes,
            renderingPolicy: input.request.renderingPolicy,
            interactionPolicy: input.request.interactionPolicy,
            classification: input.request.classification,
            expectedOutputs: input.request.expectedOutputs,
          };
          const support = dependencies.acquisition.supports(request);
          if (!support.supported)
            throw new CanonicalActivityError("ACQUISITION_ROUTE_UNSUPPORTED", support.reason, false);
          const plan = await dependencies.acquisition.plan(request);
          const admitted = {
            ...plan,
            admissionId: deterministicUuid("acquisition-admission", `${operation.id}:${plan.policyDigest}`),
          };
          const result = await dependencies.acquisition.execute(admitted);
          const verification = await dependencies.acquisition.verify(result);
          if (!verification.accepted || result.errors.length > 0 || result.artifacts.length !== 1) {
            throw new CanonicalActivityError(
              "ACQUISITION_VERIFICATION_FAILED",
              JSON.stringify({ findings: verification.findings, errors: result.errors }),
              false,
            );
          }
          const artifact = result.artifacts[0]!;
          const statusValue = result.observations.find((item) => item.key === "status")?.value;
          const httpStatus = statusValue && /^\d+$/.test(statusValue) ? Number(statusValue) : undefined;
          const sourceId = deterministicUuid(
            "knowledge-source",
            `${activity.context.tenantId}:${input.source.canonicalUrl}`,
          );
          const captureId = deterministicUuid("knowledge-capture", operation.id);
          const stored = await dependencies.repository.persistCapture(activity.context.tenantId, {
            operationId: operation.id,
            sourceId,
            captureId,
            sourceClass: input.source.sourceClass,
            canonicalUrl: input.source.canonicalUrl,
            ...(input.source.publisher ? { publisher: input.source.publisher } : {}),
            sensitivity: input.source.sensitivity,
            artifact: persistedArtifact(
              artifact,
              dependencies.sourceStorageBucket,
              "source_capture",
              "source_captures",
            ),
            captureMethod: result.captureMethod,
            captureMethodVersion: plan.adapterVersion,
            requestUrl: input.request.target.kind === "http" ? input.request.target.url : input.source.canonicalUrl,
            ...(httpStatus === undefined ? {} : { httpStatus }),
            observations: {
              plan: { normalizedTarget: plan.normalizedTarget, policyDigest: plan.policyDigest },
              verification,
              result: result.observations,
            },
            capturedAt: new Date().toISOString(),
          });
          return {
            schemaVersion: "knowledge.capture-result/v1",
            sourceId: stored.sourceId,
            captureId: stored.captureId,
            artifact: stored.artifact,
            contentDigests: result.contentDigests,
            verification,
            observations: result.observations,
            capturedAt: stored.capturedAt,
          };
        } catch (error) {
          if (error instanceof CanonicalActivityError) throw error;
          const message = error instanceof Error ? error.message : String(error);
          if (/DENIED|INVALID|UNSUPPORTED|LIMIT_EXCEEDED|MISMATCH|CONFLICT/.test(message)) {
            throw new CanonicalActivityError("ACQUISITION_POLICY_OR_INTEGRITY_FAILURE", message, false, {
              cause: error,
            });
          }
          throw error;
        }
      },
    },
    {
      operationKind: "capture",
      stepName: "seal",
      async execute({ activity, operation }) {
        captureInputSchema.parse(activity.operationInput);
        const capture = await dependencies.repository.getCaptureByOperation(activity.context.tenantId, operation.id);
        if (!capture)
          throw new CanonicalActivityError(
            "CAPTURE_NOT_MATERIALIZED",
            "Acquire step produced no canonical capture",
            false,
          );
        const bytes = await dependencies.sourceArtifacts.get(activity.context.tenantId, capture.artifact.digest);
        if (
          !bytes ||
          digestBytes(bytes) !== capture.artifact.digest ||
          bytes.byteLength !== capture.artifact.byteLength
        ) {
          throw new CanonicalActivityError(
            "CAPTURE_SEAL_VERIFICATION_FAILED",
            "Stored capture bytes do not match the canonical digest and length",
            false,
          );
        }
        return {
          schemaVersion: "knowledge.capture-seal/v1",
          captureId: capture.captureId,
          artifactId: capture.artifact.artifactId,
          digest: capture.artifact.digest,
          sizeBytes: bytes.byteLength,
          byteIdentityVerified: true,
        };
      },
    },
    {
      operationKind: "transformation",
      stepName: "convert",
      async execute({ activity, operation }) {
        const input = transformationInputSchema.parse(activity.operationInput);
        const existing = await dependencies.repository.getRepresentationByOperation(
          activity.context.tenantId,
          operation.id,
        );
        if (existing) {
          const reviewSubjectId = deterministicUuid(
            "representation-review",
            `${existing.structuralRepresentationId}:${existing.structuralArtifactDigest}`,
          );
          await review.createReviewSubject(activity.context.tenantId, {
            id: reviewSubjectId,
            operationId: operation.id,
            subjectKind: "conversion",
            subjectRef: {
              representationId: existing.structuralRepresentationId,
              artifactDigest: existing.structuralArtifactDigest,
              conversionGrade: existing.conversionGrade,
            },
            guardedSha256: existing.structuralArtifactDigest.slice(7),
            eligibleRoles: ["human_reviewer"],
          });
          return {
            schemaVersion: "knowledge.transformation-result/v1",
            ...existing,
            reviewSubjectId,
            requiresReview: true,
          };
        }
        const capture = await dependencies.repository.getCaptureByOperation(
          activity.context.tenantId,
          input.captureOperationId,
        );
        if (!capture)
          throw new CanonicalActivityError(
            "SOURCE_CAPTURE_NOT_FOUND",
            "Transformation requires a completed canonical capture operation",
            false,
          );
        if (capture.artifact.mediaType !== input.profile.mediaType)
          throw new CanonicalActivityError(
            "CONVERSION_MEDIA_TYPE_MISMATCH",
            "Profile media type does not match captured bytes",
            false,
          );
        const sourceArtifact: StoredArtifact = {
          artifactId: capture.artifact.artifactId,
          tenantId: activity.context.tenantId,
          digest: capture.artifact.digest,
          mediaType: capture.artifact.mediaType,
          byteLength: capture.artifact.byteLength,
          storageKey: capture.artifact.storageKey,
        };
        const profile: ConversionProfile = {
          profileKey: input.profile.profileKey,
          version: input.profile.version,
          mediaType: input.profile.mediaType,
          managedProcessingAllowed: input.profile.managedProcessingAllowed,
          ...(input.profile.language ? { language: input.profile.language } : {}),
          ...(input.profile.preserveHtml === undefined ? {} : { preserveHtml: input.profile.preserveHtml }),
          ...(input.profile.maximumPolls === undefined ? {} : { maximumPolls: input.profile.maximumPolls }),
        };
        for (const providerKey of input.providerRoute) {
          if (!providers.has(providerKey)) {
            throw new CanonicalActivityError(
              "CONVERSION_PROVIDER_NOT_ADMITTED",
              `Provider ${providerKey} is not configured in this worker`,
              false,
            );
          }
        }
        let output: Awaited<ReturnType<DocumentConversionProvider["convert"]>>;
        let routingReceipt: ConversionRoutingReceipt;
        try {
          const routed = await conversionRouterFromProviders([...providers.values()]).convertWithReceipt(
            { tenantId: activity.context.tenantId, sourceArtifact, profile },
            { admittedKeys: input.providerRoute },
          );
          output = routed.output;
          routingReceipt = routed.receipt;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.startsWith("CONVERSION_EXHAUSTED") || message.startsWith("CONVERSION_ROUTER_MISSING")) {
            throw new CanonicalActivityError("CONVERSION_ROUTE_EXHAUSTED", message, true);
          }
          throw error;
        }
        const structuralRepresentationId = deterministicUuid(
          "structural-representation",
          `${activity.context.tenantId}:${output.requestDigest}`,
        );
        const blocks = structuralBlocks(output.nodes);
        if (blocks.length === 0)
          throw new CanonicalActivityError(
            "CONVERSION_NO_ADMITTED_NODES",
            "Converter produced no admitted structural nodes",
            false,
          );
        const structural = convertStructuralDocument({
          tenantId: activity.context.tenantId,
          representationId: structuralRepresentationId,
          createdAt: capture.capturedAt,
          blocks,
        });
        const locatorIssues = verifyNodeLocators(structural.nodes);
        if (locatorIssues.length)
          throw new CanonicalActivityError("CONVERSION_LOCATOR_VERIFICATION_FAILED", locatorIssues.join(";"), false);
        const documentId = deterministicUuid(
          "knowledge-document",
          `${activity.context.tenantId}:${capture.sourceId}:${input.document.canonicalTitle}`,
        );
        const documentVersionId = deterministicUuid(
          "knowledge-document-version",
          `${documentId}:${input.document.versionLabel}:${capture.artifact.digest}`,
        );
        const transformationRunId = deterministicUuid("knowledge-transformation", operation.id);
        const sourceNativeRepresentationId = deterministicUuid(
          "source-native-representation",
          `${documentVersionId}:${capture.artifact.digest}`,
        );
        const native = persistedArtifact(
          output.providerNativeArtifact,
          dependencies.derivativeStorageBucket,
          "report_json",
          "candidate",
        );
        const markdown = persistedArtifact(
          output.markdownArtifact,
          dependencies.derivativeStorageBucket,
          "report_markdown",
          "candidate",
        );
        const plain =
          output.plainTextArtifact.artifactId === output.markdownArtifact.artifactId
            ? markdown
            : persistedArtifact(
                output.plainTextArtifact,
                dependencies.derivativeStorageBucket,
                "report_json",
                "candidate",
              );
        const persisted = await dependencies.repository.persistRepresentation(activity.context.tenantId, {
          operationId: operation.id,
          transformationRunId,
          sourceCaptureId: capture.captureId,
          sourceArtifact: capture.artifact,
          documentId,
          documentKind: input.document.documentKind,
          canonicalTitle: input.document.canonicalTitle,
          canonicalSourceId: capture.sourceId,
          ...(input.document.identifier
            ? {
                identifier: {
                  type: input.document.identifier.type,
                  value: input.document.identifier.value,
                  ...(input.document.identifier.authority ? { authority: input.document.identifier.authority } : {}),
                },
              }
            : {}),
          documentVersionId,
          versionLabel: input.document.versionLabel,
          manifestDigest: sha256Digest({
            capture: capture.artifact.digest,
            version: input.document.versionLabel,
          }) as `sha256:${string}`,
          sourceNativeRepresentationId,
          structuralRepresentationId,
          providerKey: output.providerKey,
          providerVersion: output.providerVersion,
          profileDigest: output.profileDigest as `sha256:${string}`,
          requestDigest: output.requestDigest as `sha256:${string}`,
          receiptDigest: output.receiptDigest as `sha256:${string}`,
          outputArtifacts: [native, markdown, plain],
          structuralArtifactId: native.artifactId,
          structuralArtifactDigest: native.digest,
          nodes: structural.nodes.map((node, index) => ({
            id: node.id,
            tenantId: node.tenantId,
            representationId: node.representationId,
            createdAt: node.createdAt,
            ...(node.parentId ? { parentId: node.parentId } : {}),
            ordinal: node.ordinal,
            stableLocalKey: blocks[index]!.localKey,
            kind: node.kind,
            ...(node.role ? { role: node.role } : {}),
            text: node.text,
            ...(node.language ? { language: node.language } : {}),
            digest: sha256Digest(node.text) as `sha256:${string}`,
            locator: node.locator,
          })),
          fidelity: {
            grade: output.fidelity.grade,
            coverage: output.metrics.characterCoverage,
            locatorCoverage: output.metrics.locatorResolvability,
            findings: output.fidelity.findings,
          },
          receipt: {
            schemaVersion: "knowledge.conversion-receipt/v1",
            provider: `${output.providerKey}@${output.providerVersion}`,
            profileDigest: output.profileDigest,
            requestDigest: output.requestDigest,
            receiptDigest: output.receiptDigest,
            candidateRoute: routingReceipt.candidateRoute,
            selectedProviderKey: routingReceipt.selectedProviderKey,
            fallbackUsed: routingReceipt.fallbackUsed,
            attempts: routingReceipt.attempts,
            artifacts: [native, markdown, plain],
            metrics: output.metrics,
            fidelity: output.fidelity,
          },
          completedAt: capture.capturedAt,
        });
        const reviewSubjectId = deterministicUuid(
          "representation-review",
          `${persisted.structuralRepresentationId}:${persisted.structuralArtifactDigest}`,
        );
        await review.createReviewSubject(activity.context.tenantId, {
          id: reviewSubjectId,
          operationId: operation.id,
          subjectKind: "conversion",
          subjectRef: {
            representationId: persisted.structuralRepresentationId,
            artifactDigest: persisted.structuralArtifactDigest,
            conversionGrade: persisted.conversionGrade,
          },
          guardedSha256: persisted.structuralArtifactDigest.slice(7),
          eligibleRoles: ["human_reviewer"],
        });
        return {
          schemaVersion: "knowledge.transformation-result/v1",
          ...persisted,
          reviewSubjectId,
          requiresReview: true,
        };
      },
    },
    {
      operationKind: "transformation",
      stepName: "inspect",
      async execute({ activity, operation }) {
        transformationInputSchema.parse(activity.operationInput);
        const representation = await dependencies.repository.getRepresentationByOperation(
          activity.context.tenantId,
          operation.id,
        );
        if (!representation || representation.nodeCount < 1)
          throw new CanonicalActivityError(
            "REPRESENTATION_INSPECTION_FAILED",
            "No canonical structural nodes were materialized",
            false,
          );
        const bytes = await dependencies.derivativeArtifacts.get(
          activity.context.tenantId,
          representation.structuralArtifactDigest,
        );
        if (!bytes)
          throw new CanonicalActivityError(
            "REPRESENTATION_ARTIFACT_MISSING",
            "Structural provider artifact is missing",
            false,
          );
        return {
          schemaVersion: "knowledge.representation-inspection/v1",
          representationId: representation.structuralRepresentationId,
          nodeCount: representation.nodeCount,
          conversionGrade: representation.conversionGrade,
          artifactDigest: representation.structuralArtifactDigest,
          artifactDigestVerified: digestBytes(bytes) === representation.structuralArtifactDigest,
          acceptanceState: representation.acceptanceState,
          requiresReview: true,
          publishable: false,
        };
      },
    },
    {
      operationKind: "chunk_set",
      stepName: "chunk",
      async execute({ activity, operation }) {
        const input = chunkSetInputSchema.parse(activity.operationInput);
        const existing = await dependencies.repository.getChunkSetByOperation(activity.context.tenantId, operation.id);
        if (existing) return existing;
        const persistedNodes = await dependencies.repository.getRepresentationNodes(
          activity.context.tenantId,
          input.representationId,
        );
        if (!persistedNodes.length)
          throw new CanonicalActivityError(
            "CHUNK_REPRESENTATION_NOT_FOUND",
            "Representation has no canonical nodes",
            false,
          );
        const nodes = persistedNodes.map((node) =>
          DocumentNodeSchema.parse({
            id: node.id,
            tenantId: node.tenantId,
            digest: node.digest,
            schemaVersion: "v1",
            createdAt: node.createdAt,
            representationId: node.representationId,
            ...(node.parentId ? { parentId: node.parentId } : {}),
            ordinal: node.ordinal,
            kind: node.kind,
            ...(node.role ? { role: node.role } : {}),
            text: node.text,
            locator: node.locator,
            ...(node.language ? { language: node.language } : {}),
          }),
        );
        const profile = defaultChunkProfileRegistry.get(input.profileName, input.profileVersion);
        const result = chunkDocument(nodes, profile);
        if (!result.qa.valid) throw new CanonicalActivityError("CHUNK_QA_FAILED", result.qa.issues.join(";"), false);
        const procedureVersionId = deterministicUuid(
          "chunk-procedure",
          `${activity.context.tenantId}:${profile.name}@${profile.version}`,
        );
        const chunkSetId = deterministicUuid(
          "chunk-set",
          `${activity.context.tenantId}:${input.representationId}:${result.outputDigest}`,
        );
        return dependencies.repository.persistChunkSet(activity.context.tenantId, {
          operationId: operation.id,
          representationId: input.representationId,
          procedureVersionId,
          procedureSlug: profile.name,
          procedureVersion: profile.version,
          tokenizer: profile.tokenizer,
          profile,
          inputDigest: result.inputDigest,
          outputDigest: result.outputDigest,
          chunkSetId,
          chunks: result.chunks.map((chunk) => ({
            id: chunk.id,
            ordinal: chunk.ordinal,
            sourceText: chunk.sourceText,
            contextualPrefix: chunk.contextualPrefix,
            embeddingText: chunk.embeddingText,
            sourceTextDigest: chunk.sourceTextDigest,
            embeddingTextDigest: chunk.embeddingTextDigest,
            sourceTokenCount: chunk.sourceTokenCount,
            embeddingTokenCount: chunk.embeddingTokenCount,
            role: chunk.role,
            spans: chunk.spans.map((span) => ({
              nodeId: span.nodeId,
              startOffset: span.startOffset,
              endOffset: span.endOffset,
              selectedTextDigest: sha256Digest(
                nodes.find((node) => node.id === span.nodeId)!.text.slice(span.startOffset, span.endOffset),
              ),
            })),
          })),
        });
      },
    },
    {
      operationKind: "chunk_set",
      stepName: "verify",
      async execute({ activity, operation }) {
        chunkSetInputSchema.parse(activity.operationInput);
        const set = await dependencies.repository.getChunkSetByOperation(activity.context.tenantId, operation.id);
        if (!set || set.chunkCount < 1 || set.spanCount < set.chunkCount || set.status !== "succeeded") {
          throw new CanonicalActivityError("CHUNK_SET_VERIFICATION_FAILED", "Persisted chunk set is incomplete", false);
        }
        return {
          schemaVersion: "knowledge.chunk-set-verification/v1",
          ...set,
          reconstructable: true,
          promotionState: "candidate",
          publishable: false,
        };
      },
    },
  ];
}

const reviewerIdentity = (activity: CanonicalActivityInvocation["activity"]) => {
  const actor = activity.context.actor;
  if (actor.kind === "model" || (actor.kind === "service" && actor.serviceIdentity !== "human_reviewer"))
    throw new CanonicalActivityError(
      "REVIEW_AUTHORITY_REQUIRED",
      "Decision requires a bearer-bound human or human_reviewer service identity",
      false,
    );
  return actor.id;
};
/** Generic bounded review capability. It records a decision for an existing guarded subject only. */
export function reviewDecisionActivityHandler(
  review: Pick<ProductionActivityDependencies["review"], "recordReviewDecision">,
): CanonicalActivityHandler {
  return {
    operationKind: "review_decision",
    stepName: "decide",
    async execute({ activity, operation }) {
      const input = reviewDecisionInputSchema.parse(activity.operationInput),
        identity = reviewerIdentity(activity);
      const decisionId = deterministicUuid(
        "knowledge-review-decision",
        `${operation.id}:${input.reviewSubjectId}:${identity}`,
      );
      await review.recordReviewDecision(activity.context.tenantId, {
        id: decisionId,
        reviewSubjectId: input.reviewSubjectId,
        guardedSha256: input.guardedDigest.slice(7),
        reviewerIdentity: identity,
        reviewerRole: "human_reviewer",
        decision: input.decision,
        rationale: input.rationale,
        decisionOperationId: operation.id,
      });
      return {
        schemaVersion: "knowledge.review-decision-result/v1",
        decisionId,
        reviewSubjectId: input.reviewSubjectId,
        decision: input.decision,
        guardedDigest: input.guardedDigest,
      };
    },
  };
}
const controlPlaneIdentity = (activity: CanonicalActivityInvocation["activity"]) => {
  const actor = activity.context.actor;
  if (actor.kind !== "service" || actor.serviceIdentity !== "control_plane")
    throw new CanonicalActivityError(
      "CONTROL_PLANE_AUTHORITY_REQUIRED",
      "Publication and rollback require the bearer-bound control_plane identity",
      false,
    );
  return actor.id;
};

function representationNodeAlignment(nodes: readonly z.infer<typeof DocumentNodeSchema>[]) {
  const byId = new Map(nodes.map((node) => [node.id, node])),
    cache = new Map<string, string>();
  const keyFor = (node: z.infer<typeof DocumentNodeSchema>, visiting = new Set<string>()): string => {
    const cached = cache.get(node.id);
    if (cached) return cached;
    if (visiting.has(node.id))
      throw new CanonicalActivityError("REPRESENTATION_NODE_CYCLE", "Representation node hierarchy is cyclic", false);
    visiting.add(node.id);
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (node.parentId && !parent)
      throw new CanonicalActivityError("REPRESENTATION_PARENT_MISSING", "Representation node parent is missing", false);
    const parentPath = parent ? keyFor(parent, visiting) : "root";
    visiting.delete(node.id);
    const locator = node.locator;
    const key = canonicalAlignmentKey({
      path: `${parentPath}/${node.ordinal}`,
      kind: node.kind,
      role: node.role ?? "",
      page: locator.page ?? null,
      sectionPath: locator.sectionPath ?? [],
      startOffset: locator.startOffset ?? null,
      startTimeMs: locator.startTimeMs ?? null,
      domPath: locator.domPath ?? "",
      symbol: locator.symbol ?? "",
    });
    cache.set(node.id, key);
    return key;
  };
  const entries = nodes.map((node) => [keyFor(node), node] as const);
  if (new Set(entries.map(([key]) => key)).size !== entries.length)
    throw new CanonicalActivityError(
      "REPRESENTATION_ALIGNMENT_AMBIGUOUS",
      "Representation has duplicate structural alignment keys",
      false,
    );
  return new Map(entries);
}
const canonicalAlignmentKey = (value: unknown) => JSON.stringify(value);

function governedIndexHandlers(
  dependencies: NonNullable<ProductionActivityDependencies["governedIndex"]>,
  review: ProductionActivityDependencies["review"],
): CanonicalActivityHandler[] {
  const recordDecision = review.recordReviewDecision;
  if (!recordDecision) throw new Error("GOVERNED_INDEX_REQUIRES_REVIEW_DECISION_REPOSITORY");
  return [
    {
      operationKind: "representation_decision",
      stepName: "decide",
      async execute({ activity, operation }) {
        const input = representationDecisionInputSchema.parse(activity.operationInput),
          identity = reviewerIdentity(activity);
        const knowledgeDecisionId = deterministicUuid(
          "knowledge-review-decision",
          `${operation.id}:${input.reviewSubjectId}:${identity}`,
        );
        const reviewDecision =
          input.decision === "accept" ? "approve" : input.decision === "quarantine" ? "reject" : input.decision;
        await recordDecision.call(review, activity.context.tenantId, {
          id: knowledgeDecisionId,
          reviewSubjectId: input.reviewSubjectId,
          guardedSha256: input.guardedDigest.slice(7),
          reviewerIdentity: identity,
          reviewerRole: "human_reviewer",
          decision: reviewDecision,
          rationale: input.rationale,
          decisionOperationId: operation.id,
        });
        const decisionId = await dependencies.repository.persistRepresentationDecision(activity.context.tenantId, {
          operationId: operation.id,
          representationId: input.representationId,
          guardedDigest: typedDigest(input.guardedDigest),
          knowledgeReviewDecisionId: knowledgeDecisionId,
          reviewerIdentity: identity,
          decision: input.decision,
          policyVersion: input.policyVersion,
          rationale: input.rationale,
          ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
        });
        return {
          schemaVersion: "knowledge.representation-decision-result/v1",
          decisionId,
          representationId: input.representationId,
          decision: input.decision,
          guardedDigest: input.guardedDigest,
          reviewDecisionId: knowledgeDecisionId,
        };
      },
    },
    {
      operationKind: "promotion_proposal",
      stepName: "propose",
      async execute({ activity, operation }) {
        const input = PromotionProposalInputSchema.parse(activity.operationInput),
          actor = activity.context.actor;
        if (
          !((actor.kind === "model" || actor.kind === "service") && actor.serviceIdentity === "content_curator_agent")
        )
          throw new CanonicalActivityError(
            "PROPOSAL_AUTHORITY_REQUIRED",
            "Projection proposals require the bearer-bound content_curator_agent identity",
            false,
          );
        const proposal = await dependencies.repository.persistProjectionProposal(activity.context.tenantId, {
          operationId: operation.id,
          chunkSetId: input.chunkSetId,
          selection: input.selection,
          selectionArtifact: input.selectionArtifact,
          representationDecisionId: input.representationDecisionId,
          projectionProcedureId: input.projectionProcedureId,
          purpose: input.purpose,
          contextualPrefix: input.contextualPrefix,
          ...(input.language ? { language: input.language } : {}),
          visibility: input.visibility,
          classification: input.classification,
          targetDomains: input.targetDomains,
          expectedValue: input.expectedValue,
          risks: input.risks,
          exclusions: input.exclusions,
          reason: input.reason,
          proposedBy: actor.id,
        });
        if (proposal.selectionDigest !== input.selectionArtifact.digest)
          throw new CanonicalActivityError(
            "PROMOTION_SELECTION_RESULT_MISMATCH",
            "Prepared proposal differs from the authenticated selection artifact",
            false,
          );
        const reviewSubjectId = deterministicUuid(
          "content-promotion-review",
          `${proposal.proposalId}:${proposal.proposalDigest}`,
        );
        await review.createReviewSubject(activity.context.tenantId, {
          id: reviewSubjectId,
          operationId: operation.id,
          subjectKind: "content_promotion",
          subjectRef: {
            proposalId: proposal.proposalId,
            projectionIds: proposal.projectionIds,
            projectionManifestDigest: proposal.projectionManifestDigest,
            selectionDigest: proposal.selectionDigest,
            selectionArtifactId: input.selectionArtifact.id,
          },
          guardedSha256: proposal.proposalDigest.slice(7),
          eligibleRoles: ["human_reviewer"],
        });
        return {
          schemaVersion: "knowledge.promotion-proposal-result/v1",
          ...proposal,
          reviewSubjectId,
          requiresIndependentDecision: true,
          publishable: false,
        };
      },
    },
    {
      operationKind: "promotion_decision",
      stepName: "decide",
      async execute({ activity, operation }) {
        const input = promotionDecisionInputSchema.parse(activity.operationInput),
          identity = reviewerIdentity(activity);
        const knowledgeDecisionId = deterministicUuid(
          "knowledge-review-decision",
          `${operation.id}:${input.reviewSubjectId}:${identity}`,
        );
        const reviewValue = input.decision === "accept" ? "approve" : input.decision;
        await recordDecision.call(review, activity.context.tenantId, {
          id: knowledgeDecisionId,
          reviewSubjectId: input.reviewSubjectId,
          guardedSha256: input.guardedDigest.slice(7),
          reviewerIdentity: identity,
          reviewerRole: "human_reviewer",
          decision: reviewValue,
          rationale: input.rationale,
          decisionOperationId: operation.id,
        });
        const decisionId = await dependencies.repository.persistPromotionDecision(activity.context.tenantId, {
          operationId: operation.id,
          proposalId: input.proposalId,
          guardedDigest: typedDigest(input.guardedDigest),
          knowledgeReviewDecisionId: knowledgeDecisionId,
          reviewerIdentity: identity,
          decision: input.decision,
          gates: input.gates,
          policyVersion: input.policyVersion,
          rationale: input.rationale,
          ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
        });
        return {
          schemaVersion: "knowledge.promotion-decision-result/v1",
          decisionId,
          proposalId: input.proposalId,
          decision: input.decision,
          guardedDigest: input.guardedDigest,
          reviewDecisionId: knowledgeDecisionId,
        };
      },
    },
    {
      operationKind: "embedding_run",
      stepName: "embed",
      async execute({ activity, operation }) {
        const input = embeddingRunInputSchema.parse(activity.operationInput),
          actor = activity.context.actor;
        if (actor.kind !== "service" || actor.serviceIdentity !== "embedding_executor")
          throw new CanonicalActivityError(
            "EMBEDDING_EXECUTOR_AUTHORITY_REQUIRED",
            "Embedding requires the bearer-bound embedding_executor identity",
            false,
          );
        const context = await dependencies.repository.loadEmbeddingContext(
          activity.context.tenantId,
          input.vectorSpaceVersionId,
          input.promotionDecisionId,
          input.projectionIds,
        );
        if (context.dimensions !== input.expectedDimensions || context.modelSlug !== input.modelSlug)
          throw new CanonicalActivityError(
            "EMBEDDING_PROFILE_MISMATCH",
            "Operation embedding profile does not match vector-space version",
            false,
          );
        const existing = await dependencies.repository.getEmbeddingRunByOperation(
          activity.context.tenantId,
          operation.id,
        );
        if (existing) return existing;
        const embedded = await dependencies.embeddingAdapter.embedMany({
          vectorSpaceVersionId: input.vectorSpaceVersionId,
          idempotencyKey: activity.context.idempotencyKey,
          expectedDimensions: input.expectedDimensions,
          modelSlug: input.modelSlug,
          providerRoute: input.providerRoute,
          inputs: context.inputs.map((item) => ({
            projectionId: item.projectionId,
            text: item.text,
            textDigest: item.textDigest,
          })),
        });
        return dependencies.repository.persistEmbeddingRun(activity.context.tenantId, {
          operationId: operation.id,
          embeddingRunId: deterministicUuid("embedding-run", operation.id),
          context,
          idempotencyKey: activity.context.idempotencyKey,
          adapterVersion: dependencies.embeddingAdapterVersion,
          providerRoutePolicy: { ordered: input.providerRoute },
          receipt: {
            requestId: embedded.requestId,
            observedProviderRoute: embedded.observedProviderRoute,
            inputManifestDigest: embedded.inputManifestDigest,
            outputManifestDigest: embedded.outputManifestDigest,
            usageTokens: embedded.usageTokens,
            costUsd: embedded.costUsd,
            latencyMs: embedded.latencyMs,
            retryHistory: embedded.retryHistory,
            items: embedded.items.map((item) => ({
              projectionId: item.projectionId,
              inputDigest: item.inputDigest,
              outputDigest: item.outputDigest,
              cacheKey: item.cacheKey,
              embedding: item.embedding,
            })),
          },
        });
      },
    },
    {
      operationKind: "embedding_run",
      stepName: "verify",
      async execute({ activity, operation }) {
        const input = embeddingRunInputSchema.parse(activity.operationInput),
          actor = activity.context.actor;
        if (actor.kind !== "service" || actor.serviceIdentity !== "embedding_executor")
          throw new CanonicalActivityError(
            "EMBEDDING_EXECUTOR_AUTHORITY_REQUIRED",
            "Embedding requires the bearer-bound embedding_executor identity",
            false,
          );
        const context = await dependencies.repository.loadEmbeddingContext(
          activity.context.tenantId,
          input.vectorSpaceVersionId,
          input.promotionDecisionId,
          input.projectionIds,
        );
        if (context.dimensions !== input.expectedDimensions || context.modelSlug !== input.modelSlug)
          throw new CanonicalActivityError(
            "EMBEDDING_PROFILE_MISMATCH",
            "Operation embedding profile does not match vector-space version",
            false,
          );
        const run = await dependencies.repository.getEmbeddingRunByOperation(activity.context.tenantId, operation.id);
        if (!run || run.itemCount < 1 || run.status !== "succeeded")
          throw new CanonicalActivityError(
            "EMBEDDING_RUN_VERIFICATION_FAILED",
            "Canonical embedding run is incomplete",
            false,
          );
        return {
          schemaVersion: "knowledge.embedding-verification/v1",
          ...run,
          dimensionVerified: true,
          publishable: false,
        };
      },
    },
    {
      operationKind: "space_publication",
      stepName: "publish",
      async execute({ activity, operation }) {
        const input = spacePublicationInputSchema.parse(activity.operationInput),
          identity = controlPlaneIdentity(activity);
        const staged = await dependencies.repository.stagePublication(activity.context.tenantId, {
          operationId: operation.id,
          publicationId: deterministicUuid("space-publication", operation.id),
          vectorStoreSpaceId: input.vectorStoreSpaceId,
          vectorSpaceVersionId: input.vectorSpaceVersionId,
          promotionDecisionId: input.promotionDecisionId,
          evaluationResultId: input.evaluationResultId,
          expectedOwnerIdentity: input.expectedOwnerIdentity,
          publisherIdentity: identity,
          ...(input.candidate ? { candidate: input.candidate } : {}),
          ...(input.candidateEvidenceDigest ? { candidateEvidenceDigest: input.candidateEvidenceDigest } : {}),
          ...(input.evaluationDigest ? { evaluationDigest: input.evaluationDigest } : {}),
        });
        if (staged.guardedDigest !== input.guardedDigest)
          throw new CanonicalActivityError(
            "PUBLICATION_GUARDED_DIGEST_MISMATCH",
            "Staged publication differs from admitted digest",
            false,
          );
        return { schemaVersion: "knowledge.space-publication-stage/v1", ...staged, publisherIdentity: identity };
      },
    },
    {
      operationKind: "space_publication",
      stepName: "verify",
      async execute({ activity, operation }) {
        const input = spacePublicationInputSchema.parse(activity.operationInput),
          identity = controlPlaneIdentity(activity),
          publicationId = deterministicUuid("space-publication", operation.id);
        await dependencies.repository.publishStaged(
          activity.context.tenantId,
          publicationId,
          operation.id,
          typedDigest(input.guardedDigest),
          input.reason,
          identity,
          `publish:${activity.context.idempotencyKey}`,
        );
        const published = await dependencies.repository.verifyPublication(activity.context.tenantId, publicationId);
        return { schemaVersion: "knowledge.space-publication-result/v1", ...published, activePointerVerified: true };
      },
    },
    {
      operationKind: "publication_rollback",
      stepName: "rollback",
      async execute({ activity }) {
        const input = publicationRollbackInputSchema.parse(activity.operationInput),
          identity = controlPlaneIdentity(activity);
        const plan = await dependencies.repository.planRollback(
          activity.context.tenantId,
          input.currentPublicationId,
          input.targetPublicationId,
          identity,
        );
        if (plan.guardedDigest !== input.guardedDigest)
          throw new CanonicalActivityError(
            "ROLLBACK_GUARDED_DIGEST_MISMATCH",
            "Rollback target differs from admitted digest",
            false,
          );
        if (
          plan.frozenBaseline &&
          (input.vectorStoreSpaceId !== plan.vectorStoreSpaceId ||
            !input.baselineQueries ||
            input.baselineQueries.length !== plan.frozenBaseline.length ||
            new Set(input.baselineQueries.map((query) => query.queryId)).size !== input.baselineQueries.length ||
            plan.frozenBaseline.some(
              (answer) =>
                !input.baselineQueries!.some(
                  (query) =>
                    query.queryId === answer.queryId && sha256Digest([...query.embedding]) === answer.embeddingDigest,
                ),
            ))
        )
          throw new CanonicalActivityError(
            "ROLLBACK_BASELINE_REQUIRED",
            "Rollback requires every frozen baseline query for its target space",
            false,
          );
        return {
          schemaVersion: "knowledge.publication-rollback-plan/v1",
          ...plan,
          currentPublicationId: input.currentPublicationId,
          targetPublicationId: input.targetPublicationId,
        };
      },
    },
    {
      operationKind: "publication_rollback",
      stepName: "verify",
      async execute({ activity, operation }) {
        const input = publicationRollbackInputSchema.parse(activity.operationInput),
          identity = controlPlaneIdentity(activity);
        const switchReceiptId = await dependencies.repository.executeRollback(
          activity.context.tenantId,
          operation.id,
          input.currentPublicationId,
          input.targetPublicationId,
          typedDigest(input.guardedDigest),
          input.reason,
          identity,
          `rollback:${activity.context.idempotencyKey}`,
        );
        const baseline =
          input.vectorStoreSpaceId && input.baselineQueries?.length
            ? await dependencies.repository.verifyPublicationBaseline(activity.context.tenantId, {
                vectorStoreSpaceId: input.vectorStoreSpaceId,
                queries: input.baselineQueries,
              })
            : undefined;
        if (baseline && !baseline.equivalent)
          throw new CanonicalActivityError(
            "ROLLBACK_BASELINE_NOT_EQUIVALENT",
            `Restored pointer answers differ: ${baseline.differences.join(",")}`,
            false,
          );
        return {
          schemaVersion: "knowledge.publication-rollback-result/v1",
          switchReceiptId,
          targetPublicationId: input.targetPublicationId,
          guardedDigest: input.guardedDigest,
          rebuilt: true,
          ...(baseline ? { baseline } : {}),
        };
      },
    },
  ];
}

function vectorVerificationHandler(
  operationKind: "vector_store_evaluation" | "publication_verification",
  retrieval: ProductionActivityDependencies["retrieval"],
  governedIndex?: ProductionActivityDependencies["governedIndex"],
): CanonicalActivityHandler {
  return {
    operationKind,
    stepName: operationKind === "vector_store_evaluation" ? "evaluate" : "verify",
    async execute({ activity }) {
      const candidate = SelectedCandidateEvaluationInputSchema.safeParse(activity.operationInput);
      if (candidate.success) {
        if (operationKind !== "vector_store_evaluation" || !governedIndex)
          throw new CanonicalActivityError(
            "CANDIDATE_EVALUATION_NOT_ADMITTED",
            "Selected-candidate evaluation requires the governed index dependency",
            false,
          );
        const actor = activity.context.actor;
        if (
          actor.kind !== "service" ||
          actor.serviceIdentity !== "evaluation_executor" ||
          !sameActorIdentity(actor.id, candidate.data.evaluatorIdentity)
        )
          throw new CanonicalActivityError(
            "EVALUATION_ACTOR_IDENTITY_MISMATCH",
            "Candidate evaluation requires its authenticated evaluation executor",
            false,
          );
        return governedIndex.repository.evaluateSelectedCandidate(activity.context.tenantId, candidate.data);
      }
      const input = vectorVerificationInputSchema.parse(activity.operationInput);
      const request = {
        tenantId: activity.context.tenantId,
        vectorSpaceVersionId: input.vectorSpaceVersionId,
        queryEmbedding: input.queryEmbedding,
        resultLimit: input.resultLimit,
      };
      const [ann, exact] = await Promise.all([retrieval.annNearest(request), retrieval.exactNearest(request)]);
      const exactIds = new Set(exact.map((item) => item.vectorItemId));
      const overlapCount = ann.filter((item) => exactIds.has(item.vectorItemId)).length;
      const denominator = Math.max(1, exact.length);
      const recallAtK = overlapCount / denominator;
      return {
        vectorSpaceVersionId: input.vectorSpaceVersionId,
        resultLimit: input.resultLimit,
        ann,
        exact,
        overlapCount,
        recallAtK,
        minimumRecallAtK: input.minimumRecallAtK,
        passed: recallAtK >= input.minimumRecallAtK,
      };
    },
  };
}

/**
 * Production registry of complete durable activities. Its exact kind/step set
 * is mechanically checked against productionWorkerStepsByKind; contract-only
 * operation names remain inadmissible instead of being queued to fail later.
 */
export function createProductionActivityRegistry(
  dependencies: ProductionActivityDependencies,
): CanonicalActivityRegistry {
  const preparation = dependencies.preparation ?? new KnowledgePreparationService();
  const evaluationHandler = (stepName: "evaluate" | "report"): CanonicalActivityHandler => ({
    operationKind: "evaluation_run",
    stepName,
    execute({ activity }) {
      try {
        const input = evaluationRunInputSchema.parse(activity.operationInput);
        const dataset = freezeEvaluationDataset(input.dataset as EvaluationDatasetInput);
        const report = evaluateRetrieval(dataset, input.outputs as EvaluationCaseOutput[], input.k);
        return JsonValueSchema.parse({ stage: stepName, report });
      } catch (error) {
        if (error instanceof ZodError) throw error;
        throw new CanonicalActivityError(
          "INVALID_EVALUATION_RUN",
          "Evaluation input violates deterministic invariants",
          false,
          { cause: error },
        );
      }
    },
  });
  return new CanonicalActivityRegistry([
    reviewDecisionActivityHandler(dependencies.review),
    ...(dependencies.durablePreparation
      ? preparationHandlers(dependencies.durablePreparation, dependencies.review)
      : []),
    ...(dependencies.governedIndex ? governedIndexHandlers(dependencies.governedIndex, dependencies.review) : []),
    ...(dependencies.vectorStore
      ? [
          {
            operationKind: "vector_store_create" as const,
            stepName: "create",
            async execute({ activity, operation }: CanonicalActivityInvocation) {
              const input = VectorStoreCreateInputSchema.parse(activity.operationInput),
                actor = activity.context.actor;
              if (actor.kind === "model")
                throw new CanonicalActivityError(
                  "VECTOR_STORE_OWNER_AUTHORITY_REQUIRED",
                  "Models cannot own vector stores",
                  false,
                );
              if (
                input.storeClass === "official_canonical" &&
                !(actor.kind === "service" && actor.serviceIdentity === "control_plane")
              )
                throw new CanonicalActivityError(
                  "CONTROL_PLANE_AUTHORITY_REQUIRED",
                  "Official canonical stores require control-plane authority",
                  false,
                );
              if (input.visibility === "public" && input.storeClass !== "official_canonical")
                throw new CanonicalActivityError(
                  "PUBLIC_STORE_AUTHORITY_REQUIRED",
                  "Only official canonical stores may be public",
                  false,
                );
              const ownerIdentity = `${actor.kind}:${actor.id}`,
                vectorStoreId = deterministicUuid("vector-store", operation.id);
              try {
                return await dependencies.vectorStore!.persistVectorStore(activity.context.tenantId, {
                  operationId: operation.id,
                  vectorStoreId,
                  ownerIdentity,
                  storeClass: input.storeClass,
                  slug: input.slug,
                  name: input.name,
                  purpose: input.purpose,
                  visibility: input.visibility,
                  quotaProfile: input.quotaProfile,
                  retentionPolicy: input.retentionPolicy,
                  deletionPolicy: input.deletionPolicy,
                  ...(input.supersedesId ? { supersedesId: input.supersedesId } : {}),
                });
              } catch (error) {
                const message = error instanceof Error ? error.message : "VECTOR_STORE_PERSISTENCE_FAILED";
                if (message.startsWith("VECTOR_STORE_"))
                  throw new CanonicalActivityError(message, message, false, { cause: error });
                throw error;
              }
            },
          },
          {
            operationKind: "vector_store_documents" as const,
            stepName: "validate",
            async execute({ activity }: CanonicalActivityInvocation) {
              const input = VectorStoreDocumentsInputSchema.parse(activity.operationInput);
              if (new Set(input.documents.map((item) => item.documentId)).size !== input.documents.length)
                throw new CanonicalActivityError(
                  "VECTOR_STORE_DOCUMENT_DUPLICATE",
                  "Document attachments must be unique",
                  false,
                );
              return {
                schemaVersion: "knowledge.vector-store-documents-validation/v1",
                vectorStoreId: input.vectorStoreId,
                documentCount: input.documents.length,
                requestDigest: sha256Digest(JsonValueSchema.parse(input)),
                valid: true,
              };
            },
          },
          {
            operationKind: "vector_store_documents" as const,
            stepName: "attach",
            async execute({ activity, operation }: CanonicalActivityInvocation) {
              const input = VectorStoreDocumentsInputSchema.parse(activity.operationInput),
                actor = activity.context.actor;
              if (actor.kind === "model")
                throw new CanonicalActivityError(
                  "VECTOR_STORE_OWNER_AUTHORITY_REQUIRED",
                  "Models cannot attach vector-store documents",
                  false,
                );
              try {
                return await dependencies.vectorStore!.attachDocuments(activity.context.tenantId, {
                  operationId: operation.id,
                  vectorStoreId: input.vectorStoreId,
                  actorIdentity: `${actor.kind}:${actor.id}`,
                  controlPlaneOverride: actor.kind === "service" && actor.serviceIdentity === "control_plane",
                  documents: input.documents.map((item) => ({
                    id: deterministicUuid("vector-store-document", `${operation.id}:${item.documentId}`),
                    documentId: item.documentId,
                    documentVersionId: item.documentVersionId,
                    representationId: item.representationId,
                    requestedProfile: item.requestedProfile,
                  })),
                });
              } catch (error) {
                const message = error instanceof Error ? error.message : "VECTOR_STORE_DOCUMENT_PERSISTENCE_FAILED";
                if (message.startsWith("VECTOR_STORE_") || message === "CONTROL_PLANE_AUTHORITY_REQUIRED")
                  throw new CanonicalActivityError(message, message, false, { cause: error });
                throw error;
              }
            },
          },
        ]
      : []),
    ...(dependencies.vectorStore || dependencies.governedIndex
      ? (["prepare", "embed", "index"] as const).map(
          (stepName): CanonicalActivityHandler => ({
            operationKind: "vector_store_ingestion",
            stepName,
            async execute({ activity, operation }) {
              if (
                (activity.operationInput as Record<string, unknown>)?.schemaVersion ===
                "knowledge.selected-candidate-index/v1"
              ) {
                const input = SelectedCandidateIndexInputSchema.parse(activity.operationInput),
                  actor = activity.context.actor;
                if (
                  actor.kind !== "service" ||
                  !["embedding_executor", "control_plane"].includes(actor.serviceIdentity)
                )
                  throw new CanonicalActivityError(
                    "CANDIDATE_INDEX_AUTHORITY_REQUIRED",
                    "Candidate indexing requires an embedding executor or control-plane service",
                    false,
                  );
                if (!dependencies.governedIndex)
                  throw new CanonicalActivityError(
                    "CANDIDATE_INDEX_NOT_CONFIGURED",
                    "Selected candidate repository is required",
                    false,
                  );
                const candidate = await dependencies.governedIndex.repository.verifySelectedCandidate(
                  activity.context.tenantId,
                  input,
                );
                return { ...candidate, stage: stepName };
              }
              if (!dependencies.vectorStore)
                throw new CanonicalActivityError(
                  "VECTOR_STORE_NOT_CONFIGURED",
                  "Vector-store lifecycle repository is required",
                  false,
                );
              const input = VectorStoreIngestionInputSchema.parse(activity.operationInput),
                actor = activity.context.actor;
              if (actor.kind === "model")
                throw new CanonicalActivityError(
                  "VECTOR_STORE_OWNER_AUTHORITY_REQUIRED",
                  "Models cannot execute vector-store ingestion",
                  false,
                );
              const stage = stepName === "prepare" ? "prepared" : stepName === "embed" ? "embedded" : "indexed";
              try {
                return await dependencies.vectorStore!.verifyIngestionStage(
                  activity.context.tenantId,
                  {
                    operationId: operation.id,
                    ingestionRunId: deterministicUuid("vector-store-ingestion", operation.id),
                    vectorStoreId: input.vectorStoreId,
                    actorIdentity: `${actor.kind}:${actor.id}`,
                    controlPlaneOverride: actor.kind === "service" && actor.serviceIdentity === "control_plane",
                    requestDigest: sha256Digest(JsonValueSchema.parse(input)),
                    chains: input.chains,
                  },
                  stage,
                );
              } catch (error) {
                const message = error instanceof Error ? error.message : "VECTOR_STORE_INGESTION_FAILED";
                if (message.startsWith("VECTOR_STORE_") || message === "CONTROL_PLANE_AUTHORITY_REQUIRED")
                  throw new CanonicalActivityError(message, message, message.endsWith("_INCOMPLETE"), { cause: error });
                throw error;
              }
            },
          }),
        )
      : []),
    {
      operationKind: "source_discovery",
      stepName: "discover",
      execute({ activity }) {
        const input = sourceDiscoveryInputSchema.parse(activity.operationInput);
        const byUrl = new Map<string, (typeof input.candidates)[number]>();
        for (const candidate of [...input.candidates].sort(
          (left, right) => right.score - left.score || left.url.localeCompare(right.url),
        )) {
          const url = new URL(candidate.url);
          url.hash = "";
          url.hostname = url.hostname.toLowerCase();
          if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80"))
            url.port = "";
          url.searchParams.sort();
          const canonicalUrl = url.href;
          if (!byUrl.has(canonicalUrl))
            byUrl.set(canonicalUrl, { ...candidate, url: canonicalUrl, evidence: [...candidate.evidence].sort() });
        }
        const candidates = [...byUrl.values()]
          .sort((left, right) => right.score - left.score || left.url.localeCompare(right.url))
          .slice(0, input.limit)
          .map((candidate, ordinal) => {
            const material = {
              url: candidate.url,
              title: candidate.title,
              sourceClass: candidate.sourceClass,
              ...(candidate.publisher ? { publisher: candidate.publisher } : {}),
              score: candidate.score,
              evidence: candidate.evidence,
            };
            return {
              ...material,
              candidateId: deterministicUuid("source-discovery-candidate", candidate.url),
              rank: ordinal + 1,
              candidateDigest: sha256Digest(material),
            };
          });
        return {
          schemaVersion: "knowledge.source-discovery-result/v1",
          query: input.query,
          candidateCount: candidates.length,
          candidates,
          resultDigest: sha256Digest(JsonValueSchema.parse({ query: input.query, candidates })),
        };
      },
    },
    {
      operationKind: "source_resolution",
      stepName: "resolve",
      execute({ activity }) {
        const input = sourceResolutionInputSchema.parse(activity.operationInput);
        const resolved = input.candidates
          .map((candidate) => {
            let canonicalIdentifier: string;
            if (candidate.identifierKind === "url") {
              const url = new URL(candidate.identifier);
              url.hash = "";
              url.hostname = url.hostname.toLowerCase();
              if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80"))
                url.port = "";
              url.searchParams.sort();
              canonicalIdentifier = url.href;
            } else
              canonicalIdentifier = `${candidate.identifierKind}:${normalizePaperIdentifier(candidate.identifierKind, candidate.identifier)}`;
            return {
              ...candidate,
              canonicalIdentifier,
              sourceId: deterministicUuid("resolved-source", canonicalIdentifier),
              resolutionDigest: sha256Digest({ candidateId: candidate.candidateId, canonicalIdentifier }),
            };
          })
          .sort((left, right) => left.candidateId.localeCompare(right.candidateId));
        if (new Set(resolved.map((item) => item.candidateId)).size !== resolved.length)
          throw new CanonicalActivityError("DUPLICATE_SOURCE_CANDIDATE", "Source candidate ids must be unique", false);
        return {
          schemaVersion: "knowledge.source-resolution-result/v1",
          resolvedCount: resolved.length,
          resolved,
          resultDigest: sha256Digest(resolved),
        };
      },
    },
    {
      operationKind: "chunk_preview",
      stepName: "preview",
      execute({ activity }) {
        const input = chunkPreviewInputSchema.parse(activity.operationInput);
        const profile = defaultChunkProfileRegistry.get(input.profileName, input.profileVersion);
        const result = chunkDocument(input.nodes, profile);
        return { schemaVersion: "knowledge.chunk-preview-result/v1", ...result, persisted: false };
      },
    },
    {
      operationKind: "chunk_comparison",
      stepName: "compare",
      execute({ activity }) {
        const input = chunkComparisonInputSchema.parse(activity.operationInput);
        const keys = input.profiles.map((profile) => `${profile.name}@${profile.version}`);
        if (new Set(keys).size !== keys.length)
          throw new CanonicalActivityError(
            "DUPLICATE_CHUNK_PROFILE",
            "Chunk comparison profiles must be unique",
            false,
          );
        const variants = input.profiles
          .map(({ name, version }) => chunkDocument(input.nodes, defaultChunkProfileRegistry.get(name, version)))
          .map((result) => ({
            profile: { name: result.profile.name, version: result.profile.version, strategy: result.profile.strategy },
            inputDigest: result.inputDigest,
            outputDigest: result.outputDigest,
            chunkCount: result.chunks.length,
            omittedNodeCount: result.omittedNodeIds.length,
            qa: result.qa,
            totalSourceTokens: result.chunks.reduce((sum, chunk) => sum + chunk.sourceTokenCount, 0),
            totalEmbeddingTokens: result.chunks.reduce((sum, chunk) => sum + chunk.embeddingTokenCount, 0),
          }));
        return {
          schemaVersion: "knowledge.chunk-comparison-result/v1",
          variants,
          comparisonDigest: sha256Digest(JsonValueSchema.parse(variants)),
        };
      },
    },
    {
      operationKind: "representation_comparison",
      stepName: "compare",
      execute({ activity }) {
        const input = representationComparisonInputSchema.parse(activity.operationInput);
        for (const side of [input.left, input.right]) {
          if (new Set(side.nodes.map((node) => node.id)).size !== side.nodes.length)
            throw new CanonicalActivityError(
              "DUPLICATE_DOCUMENT_NODE",
              "Representation node ids must be unique",
              false,
            );
          if (side.nodes.some((node) => node.representationId !== side.representationId))
            throw new CanonicalActivityError(
              "REPRESENTATION_NODE_IDENTITY_MISMATCH",
              "Every node must belong to its compared representation",
              false,
            );
        }
        const left = representationNodeAlignment(input.left.nodes),
          right = representationNodeAlignment(input.right.nodes);
        const removed = [...left.keys()].filter((key) => !right.has(key)).sort(),
          added = [...right.keys()].filter((key) => !left.has(key)).sort();
        const changed = [...left]
          .filter(([key, node]) => right.has(key) && right.get(key)!.digest !== node.digest)
          .map(([key, leftNode]) => ({
            alignmentKey: key,
            leftNodeId: leftNode.id,
            rightNodeId: right.get(key)!.id,
            leftDigest: leftNode.digest,
            rightDigest: right.get(key)!.digest,
          }))
          .sort((a, b) => a.alignmentKey.localeCompare(b.alignmentKey));
        const result = {
          leftRepresentationId: input.left.representationId,
          rightRepresentationId: input.right.representationId,
          identical:
            input.left.digest === input.right.digest &&
            added.length === 0 &&
            removed.length === 0 &&
            changed.length === 0,
          addedAlignmentKeys: added,
          removedAlignmentKeys: removed,
          changedNodes: changed,
        };
        return {
          schemaVersion: "knowledge.representation-comparison-result/v1",
          ...result,
          comparisonDigest: sha256Digest(result),
        };
      },
    },
    {
      operationKind: "experiment",
      stepName: "record",
      execute({ activity }) {
        const input = experimentInputSchema.parse(activity.operationInput);
        if (input.dataset.cases.length > 500 || input.arms.some((arm) => arm.outputs.length > 500))
          throw new CanonicalActivityError(
            "EXPERIMENT_CASE_LIMIT_EXCEEDED",
            "Experiments are limited to 500 cases per arm",
            false,
          );
        const dataset = freezeEvaluationDataset(input.dataset as EvaluationDatasetInput);
        const matrix = createExperimentMatrix<JsonValue>(
          input.id,
          input.hypothesis,
          dataset,
          input.arms.map(({ outputs: _, ...arm }) => arm),
        );
        const arms = input.arms.map((arm) => ({
          arm: { id: arm.id, name: arm.name, configuration: arm.configuration, control: arm.control },
          report: evaluateRetrieval(dataset, arm.outputs as EvaluationCaseOutput[], input.k),
        }));
        const control = arms.find((arm) => arm.arm.control);
        if (!control)
          throw new CanonicalActivityError("EXPERIMENT_CONTROL_REQUIRED", "Experiment requires one control", false);
        const comparisons = arms
          .filter((arm) => !arm.arm.control)
          .map((arm) => ({
            armId: arm.arm.id,
            controlArmId: control.arm.id,
            recallAtKDelta: Number((arm.report.overall.recallAtK - control.report.overall.recallAtK).toFixed(12)),
            ndcgAtKDelta: Number((arm.report.overall.ndcgAtK - control.report.overall.ndcgAtK).toFixed(12)),
            p95LatencyMsDelta: arm.report.overall.p95LatencyMs - control.report.overall.p95LatencyMs,
            totalCostMicrosDelta: arm.report.overall.totalCostMicros - control.report.overall.totalCostMicros,
          }));
        const material = { matrixDigest: matrix.digest, arms, comparisons };
        return {
          schemaVersion: "knowledge.experiment-result/v1",
          ...material,
          resultDigest: sha256Digest(JsonValueSchema.parse(material)),
        };
      },
    },
    {
      operationKind: "source_vetting",
      stepName: "vet",
      async execute({ activity, operation }) {
        const bundle = vettedBundleSchema.parse(activity.operationInput) as VettedBundleInput;
        const result = preparation.vetOnly(bundle);
        const proposal = result.proposals[0];
        if (!proposal) {
          throw new CanonicalActivityError(
            "SOURCE_VETTING_PROPOSAL_MISSING",
            "Source vetting produced no reviewable proposal",
            false,
          );
        }
        const reviewSubjectId = deterministicUuid("source-vetting-review", `${operation.id}:${proposal.guardedDigest}`);
        await dependencies.review.createReviewSubject(activity.context.tenantId, {
          id: reviewSubjectId,
          operationId: operation.id,
          subjectKind: "source_vetting",
          subjectRef: proposal,
          guardedSha256: proposal.guardedDigest.slice(7),
          eligibleRoles: ["human_reviewer"],
        });
        return JsonValueSchema.parse({ ...result, reviewSubjectId });
      },
    },
    {
      operationKind: "evaluation_dataset",
      stepName: "freeze",
      execute({ activity }) {
        try {
          const dataset = evaluationDatasetInputSchema.parse(activity.operationInput) as EvaluationDatasetInput;
          return JsonValueSchema.parse(freezeEvaluationDataset(dataset));
        } catch (error) {
          if (error instanceof ZodError) throw error;
          throw new CanonicalActivityError(
            "INVALID_EVALUATION_DATASET",
            "Dataset violates deterministic freeze invariants",
            false,
            { cause: error },
          );
        }
      },
    },
    evaluationHandler("evaluate"),
    evaluationHandler("report"),
    vectorVerificationHandler("vector_store_evaluation", dependencies.retrieval, dependencies.governedIndex),
    vectorVerificationHandler("publication_verification", dependencies.retrieval),
    {
      operationKind: "evidence_packet",
      stepName: "packet",
      async execute({ activity }) {
        const input = evidencePacketInputSchema.parse(activity.operationInput);
        const packetId = await dependencies.retrieval.storeEvidencePacket(activity.context.tenantId, input);
        return { packetId, digest: input.packet.digest, persisted: true };
      },
    },
    ...(dependencies.verificationHandlers ?? []),
  ]);
}

export function retryableActivityFailure(error: unknown): boolean {
  return error instanceof CanonicalActivityError ? error.retryable : true;
}

export function activityFailureClass(error: unknown): string {
  if (error instanceof CanonicalActivityError) return error.code;
  return error instanceof Error ? error.name : "UNKNOWN_ACTIVITY_FAILURE";
}

export function createCanonicalActivityExecutor(
  operations: Pick<OperationsRepository, "getOperationRecord">,
  registry: CanonicalActivityRegistry,
) {
  return async (claim: LeasedStep): Promise<JsonValue> => {
    const operation = await operations.getOperationRecord(claim.tenantId, claim.operationId);
    if (!operation) {
      throw new CanonicalActivityError(
        "ACTIVITY_OPERATION_NOT_FOUND",
        `Operation ${claim.operationId} is missing for leased step ${claim.id}`,
        false,
      );
    }
    return registry.execute(operation, claim);
  };
}

export function durableActivityInput(value: unknown): DurableStepInput {
  return durableStepInputSchema.parse(value);
}
