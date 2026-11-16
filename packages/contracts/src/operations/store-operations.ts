import { z } from "zod";
import { OperationStatusSchema } from "../integration.js";
import { VectorStoreResourceSchema } from "../resources.js";
import { VectorStoreCreateInputSchema, VectorStoreDocumentsInputSchema } from "../vector-store.js";
import { acceptedResult, EXAMPLE, type OperationContract } from "./contract-types.js";
import {
  EmbeddingRunInputSchema,
  PublicationRollbackInputSchema,
  SpacePublicationInputSchema,
  VectorStoreEvaluationInputSchema,
  VectorStoreIngestionJobInputSchema,
  VectorVerificationInputSchema,
} from "./publication-inputs.js";
import { VectorStoreOperationReadInputSchema } from "./retrieval-inputs.js";

const STORE = EXAMPLE.id(60);
const SPACE_VERSION = EXAMPLE.id(61);
/** A query vector of the one admitted size: 1536 numbers. */
const QUERY_VECTOR = [1, ...Array.from({ length: 1_535 }, () => 0)];
const VECTOR_NOTE =
  "queryEmbedding is the query vector itself: exactly 1536 finite numbers, produced by the model of the vector-space version.";
const CONTROL_PLANE_NOTE =
  "The caller must be a service with the control_plane identity holding the publication.execute permission; any other caller is refused.";

/** Vector stores, embedding and the publication of vector spaces. */
export const STORE_OPERATIONS: readonly OperationContract[] = [
  {
    operation: "vector_store_create",
    kind: "vector_store_create",
    effect: "submit",
    summary:
      "Create a vector store owned by the caller, with its class, visibility, quota, retention and deletion rules.",
    when: "Use once per store, before knowledge_store_add_documents; it holds no documents or vectors yet.",
    returns:
      "Returns the accepted operation; poll knowledge_promotion_status. Then attach documents with knowledge_store_add_documents.",
    input: VectorStoreCreateInputSchema,
    shape: "envelope",
    notes: [
      "A model cannot own a store: the caller must be a human or a service.",
      "storeClass official_canonical needs a service caller with the control_plane identity, and visibility public is allowed only for official_canonical.",
      "quotaProfile.maximumBytes is in bytes; retentionPolicy.days and deletionPolicy.minimumRetentionDays are in days.",
      "slug is lower-case letters and digits separated by single hyphens.",
    ],
    example: {
      schemaVersion: "knowledge.vector-store/v1",
      slug: "agent-research",
      name: "Agent research",
      purpose: "Exploratory store for agent orchestration sources.",
      storeClass: "internal_exploratory",
      visibility: "tenant",
      quotaProfile: { maximumDocuments: 1_000, maximumBytes: 1_000_000_000, maximumSpaces: 4 },
      retentionPolicy: { mode: "indefinite" },
      deletionPolicy: { mode: "tombstone_only", minimumRetentionDays: 30 },
    },
    result: acceptedResult(
      "On success the step records the stored vector store. Its id is derived from the operation id and its owner is the caller.",
    ),
    related: ["tool:knowledge_store_add_documents", "tool:knowledge_store_status", "tool:knowledge_promotion_status"],
    mcp: ["knowledge_store_create"],
    cli: ["knowledge store create"],
    http: ["POST /v1/vector-stores"],
  },
  {
    operation: "vector_store_documents",
    kind: "vector_store_documents",
    effect: "submit",
    summary: "Attach converted documents to a vector store so they can be prepared for it.",
    when: "Use after knowledge_store_create and knowledge_document_convert; it embeds and publishes nothing.",
    returns:
      "Returns the accepted operation; poll knowledge_store_status with the same vectorStoreId and this operationId.",
    input: VectorStoreDocumentsInputSchema,
    shape: "envelope",
    notes: [
      "documents holds 1 to 1000 entries and no documentId may repeat; a repeat fails the operation when it runs.",
      "A model cannot attach documents: the caller must be a human or a service.",
      "requestedProfile is any JSON value stored with the attachment.",
      "Over HTTP the vectorStoreId in the path must equal input.vectorStoreId.",
    ],
    example: {
      schemaVersion: "knowledge.vector-store-documents/v1",
      vectorStoreId: STORE,
      documents: [
        {
          documentId: EXAMPLE.id(62),
          documentVersionId: EXAMPLE.id(63),
          representationId: EXAMPLE.id(20),
          requestedProfile: { chunkProfile: "heading-sections-v1@1.0.0" },
        },
      ],
    },
    result: acceptedResult(
      "On success the validate step records { schemaVersion: 'knowledge.vector-store-documents-validation/v1', vectorStoreId, documentCount, requestDigest, valid: true } and the attach step records the stored attachments.",
    ),
    related: ["tool:knowledge_store_create", "tool:knowledge_store_status", "tool:knowledge_store_evaluate"],
    mcp: ["knowledge_store_add_documents"],
    cli: ["knowledge store add-documents"],
    http: ["POST /v1/vector-stores/{vectorStoreId}/documents"],
  },
  {
    operation: "vector_store_ingestion",
    kind: "vector_store_ingestion",
    effect: "submit",
    summary: "Check that each attached document of a store has a complete chain from conversion to publication.",
    when: "Use after the chain's operations finished; it converts, embeds and publishes nothing itself. It has no MCP tool or ks command.",
    returns:
      "Returns the accepted operation; read it with knowledge_store_status. Each of its three steps confirms one stage of every chain.",
    input: VectorStoreIngestionJobInputSchema,
    shape: "envelope",
    notes: [
      "The plain form (schemaVersion knowledge.vector-store-ingestion/v1) lists 1 to 1000 chains; each chain names the ids and operation ids of one attachment's conversion, chunk set, promotion proposal, promotion decision, embedding run and publication.",
      "The other form (schemaVersion knowledge.selected-candidate-index/v1) reconciles one selected candidate and needs a service caller with the embedding_executor or control_plane identity.",
      "A model cannot run it. Over HTTP the vectorStoreId in the path must equal input.vectorStoreId, so that route takes the plain form.",
      "Leave a2a out: it is filled by the service for tasks that arrive through the agent-to-agent route.",
    ],
    example: {
      schemaVersion: "knowledge.vector-store-ingestion/v1",
      vectorStoreId: STORE,
      chains: [
        {
          attachmentId: EXAMPLE.id(64),
          transformationOperationId: EXAMPLE.id(65),
          chunkSetId: EXAMPLE.id(45),
          chunkSetOperationId: EXAMPLE.id(66),
          promotionProposalId: EXAMPLE.id(48),
          promotionProposalOperationId: EXAMPLE.id(67),
          promotionDecisionId: EXAMPLE.id(68),
          promotionDecisionOperationId: EXAMPLE.id(69),
          embeddingRunId: EXAMPLE.id(70),
          embeddingOperationId: EXAMPLE.id(71),
          publicationId: EXAMPLE.id(72),
          publicationOperationId: EXAMPLE.id(73),
        },
      ],
    },
    result: acceptedResult(
      "On success the prepare, embed and index steps each record the verified stage of the listed chains. A chain that is not complete yet fails the step in a way the worker retries.",
    ),
    related: ["tool:knowledge_store_add_documents", "tool:knowledge_store_status", "operation:space_publication"],
    mcp: [],
    cli: [],
    http: ["POST /v1/vector-stores/{vectorStoreId}/ingestion-jobs"],
  },
  {
    operation: "vector_store_evaluation",
    kind: "vector_store_evaluation",
    effect: "submit",
    summary: "Measure how well approximate search in one vector-space version matches exact search for a query vector.",
    when: "Use to test an index before it is published; knowledge_eval_run scores retrieval answers against judged cases instead.",
    returns: "Returns the accepted operation; poll knowledge_promotion_status. Its output has recallAtK and passed.",
    input: VectorStoreEvaluationInputSchema,
    shape: "envelope",
    notes: [
      VECTOR_NOTE,
      "resultLimit is the number of neighbours compared: 1 to 100, 20 when omitted. minimumRecallAtK is the pass mark from 0 to 1, 0.95 when omitted.",
      "A second form (schemaVersion knowledge.selected-candidate-evaluation/v1) evaluates a selected candidate with 1 to 16 query vectors whose queryId values differ; it needs a service caller with the evaluation_executor identity whose id is evaluatorIdentity.",
    ],
    example: { vectorSpaceVersionId: SPACE_VERSION, queryEmbedding: QUERY_VECTOR },
    result: acceptedResult(
      "On success the plain form records { vectorSpaceVersionId, resultLimit, ann, exact, overlapCount, recallAtK, minimumRecallAtK, passed }, where passed is recallAtK >= minimumRecallAtK.",
    ),
    related: ["tool:knowledge_embed_run", "tool:knowledge_eval_run", "tool:knowledge_promotion_status"],
    mcp: ["knowledge_store_evaluate"],
    cli: ["knowledge store evaluate"],
    http: ["POST /v1/vector-stores/{resourceId}:evaluate"],
  },
  {
    operation: "vector_store_operation",
    effect: "read",
    summary: "Read the state of one operation that belongs to a vector store.",
    when: "Use for store operations such as attaching documents or an ingestion check; knowledge_promotion_status reads any operation by id alone.",
    returns: "Returns the operation status: kind, state, receiptIds and, after a failure, a failure summary.",
    input: VectorStoreOperationReadInputSchema,
    shape: "envelope",
    notes: [
      "An operation belongs to a store when its input names that vectorStoreId (attaching documents, the ingestion check); any other operation is answered NOT_FOUND.",
      "On MCP an input without valid vectorStoreId and operationId values is refused with RESOURCE_ID_REQUIRED.",
    ],
    example: { vectorStoreId: STORE, operationId: EXAMPLE.id(2) },
    result: {
      name: "OperationStatus",
      schema: OperationStatusSchema,
      outcome: "state is one of queued, running, needs_review, quarantined, succeeded, failed, cancelled.",
    },
    related: ["tool:knowledge_store_add_documents", "tool:knowledge_promotion_status"],
    mcp: ["knowledge_store_status"],
    cli: ["knowledge store status"],
    http: ["GET /v1/vector-stores/{vectorStoreId}/operations/{operationId}"],
  },
  {
    operation: "vector_store",
    effect: "read",
    summary: "Read one vector store: its class, owner, lifecycle, policies, document count and spaces.",
    when: "Use to inspect a store after it was created; it has no MCP tool.",
    returns: "Returns the vector store with at most 100 spaces; spacesTruncated says whether more exist.",
    input: z.strictObject({ vectorStoreId: z.uuid() }),
    shape: "envelope",
    notes: ["A store of another tenant is answered NOT_FOUND."],
    example: { vectorStoreId: STORE },
    result: {
      name: "VectorStoreResource",
      schema: VectorStoreResourceSchema,
      outcome: "Each space names its vector space and, when one is published, the active version.",
    },
    related: ["tool:knowledge_store_create", "tool:knowledge_store_status"],
    mcp: [],
    cli: ["knowledge store show"],
    http: ["GET /v1/vector-stores/{vectorStoreId}"],
  },
  {
    operation: "embedding_run",
    kind: "embedding_run",
    effect: "submit",
    summary: "Embed approved projections into one vector-space version and record the run.",
    when: "Use after a reviewer accepted the promotion proposal; it does not publish, so searches do not see the vectors yet.",
    returns:
      "Returns the accepted operation; poll knowledge_promotion_status. Publication is a separate operator step.",
    input: EmbeddingRunInputSchema,
    shape: "envelope",
    notes: [
      "The caller must be a service with the embedding_executor identity; any other caller is refused when the operation runs.",
      "expectedDimensions has one admitted value, 1536, and modelSlug must be the model of the vector-space version, or the operation fails.",
      "promotionDecisionId is the decision that approved the projections in projectionIds.",
      "providerRoute lists embedding providers in the order to use them; the example's provider and model names are placeholders.",
    ],
    example: {
      schemaVersion: "knowledge.embedding-run/v1",
      vectorSpaceVersionId: SPACE_VERSION,
      promotionDecisionId: EXAMPLE.id(68),
      projectionIds: [EXAMPLE.id(74)],
      providerRoute: ["example-provider"],
      expectedDimensions: 1536,
      modelSlug: "example-embedding-model",
    },
    result: acceptedResult(
      "On success the embed step records the stored embedding run and the verify step records { schemaVersion: 'knowledge.embedding-verification/v1', the run, dimensionVerified: true, publishable: false }.",
    ),
    related: [
      "tool:knowledge_promotion_propose",
      "tool:knowledge_promotion_status",
      "tool:knowledge_store_evaluate",
      "operation:space_publication",
    ],
    mcp: ["knowledge_embed_run"],
    cli: ["knowledge embed run"],
    http: ["POST /v1/embedding-runs"],
  },
  {
    operation: "space_publication",
    kind: "space_publication",
    effect: "submit",
    summary: "Make one evaluated vector-space version the active version that searches read.",
    when: "Use as the operator step after embedding and evaluation; agents cannot publish and it has no MCP tool.",
    returns:
      "Returns the accepted operation. Its output confirms the active pointer; undo it with a publication rollback.",
    input: SpacePublicationInputSchema,
    shape: "envelope",
    notes: [
      CONTROL_PLANE_NOTE,
      "guardedDigest must equal the digest the service computes when it stages the publication, or the operation fails.",
      "candidate, candidateEvidenceDigest and evaluationDigest are given together when the version being published is an evaluated selected candidate.",
    ],
    example: {
      schemaVersion: "knowledge.space-publication/v1",
      vectorStoreSpaceId: EXAMPLE.id(75),
      vectorSpaceVersionId: SPACE_VERSION,
      promotionDecisionId: EXAMPLE.id(68),
      evaluationResultId: EXAMPLE.id(76),
      expectedOwnerIdentity: `service:${EXAMPLE.id(4)}`,
      guardedDigest: EXAMPLE.digest("a"),
      reason: "Evaluation passed.",
    },
    result: acceptedResult(
      "On success the publish step records { schemaVersion: 'knowledge.space-publication-stage/v1', the staged publication, publisherIdentity } and the verify step records { schemaVersion: 'knowledge.space-publication-result/v1', the publication, activePointerVerified: true }.",
    ),
    related: ["tool:knowledge_embed_run", "operation:publication_verification", "operation:publication_rollback"],
    mcp: [],
    cli: ["knowledge space publish"],
    http: ["POST /v1/space-publications"],
  },
  {
    operation: "publication_verification",
    kind: "publication_verification",
    effect: "submit",
    summary: "Measure how well approximate search in a vector-space version matches exact search for a query vector.",
    when: "Use on a published version; it is the same check as a plain vector store evaluation and has no MCP tool.",
    returns: "Returns the accepted operation. Its output has recallAtK and passed.",
    input: VectorVerificationInputSchema,
    shape: "envelope",
    notes: [
      VECTOR_NOTE,
      "resultLimit is the number of neighbours compared: 1 to 100, 20 when omitted. minimumRecallAtK is the pass mark from 0 to 1, 0.95 when omitted.",
    ],
    example: { vectorSpaceVersionId: SPACE_VERSION, queryEmbedding: QUERY_VECTOR },
    result: acceptedResult(
      "On success the step records { vectorSpaceVersionId, resultLimit, ann, exact, overlapCount, recallAtK, minimumRecallAtK, passed }.",
    ),
    related: ["operation:space_publication", "tool:knowledge_store_evaluate"],
    mcp: [],
    cli: ["knowledge embed verify"],
    http: ["POST /v1/space-publications/{resourceId}:verify"],
  },
  {
    operation: "publication_rollback",
    kind: "publication_rollback",
    effect: "submit",
    summary: "Switch a vector space back from its current publication to an earlier one.",
    when: "Use as the operator step to undo a publication; agents cannot roll back and it has no MCP tool.",
    returns:
      "Returns the accepted operation. Its output has the switch receipt and, when queries were given, the baseline comparison.",
    input: PublicationRollbackInputSchema,
    shape: "envelope",
    notes: [
      CONTROL_PLANE_NOTE,
      "guardedDigest must equal the digest of the rollback the service plans from currentPublicationId to targetPublicationId, or the operation fails.",
      "When the target publication has a frozen baseline, vectorStoreSpaceId and baselineQueries are required: one entry per frozen query, with different queryId values and the same 1536-number vectors; the restored answers must equal the baseline.",
    ],
    example: {
      schemaVersion: "knowledge.publication-rollback/v1",
      currentPublicationId: EXAMPLE.id(72),
      targetPublicationId: EXAMPLE.id(77),
      guardedDigest: EXAMPLE.digest("a"),
      reason: "The new version regressed.",
    },
    result: acceptedResult(
      "On success the rollback step records { schemaVersion: 'knowledge.publication-rollback-plan/v1', the plan, currentPublicationId, targetPublicationId } and the verify step records { schemaVersion: 'knowledge.publication-rollback-result/v1', switchReceiptId, targetPublicationId, guardedDigest, rebuilt: true, baseline? }.",
    ),
    related: ["operation:space_publication", "operation:publication_verification"],
    mcp: [],
    cli: ["knowledge space rollback"],
    http: ["POST /v1/space-publications/{resourceId}:rollback"],
  },
];
