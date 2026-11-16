import { z } from "zod";
import { acceptedResult, EXAMPLE, type OperationContract } from "./contract-types.js";
import {
  ChunkComparisonInputSchema,
  ChunkPreviewInputSchema,
  ChunkSetInputSchema,
  RepresentationComparisonInputSchema,
  RepresentationDecisionInputSchema,
  TransformationInputSchema,
} from "./preparation-inputs.js";
import { EmptyInputSchema } from "./retrieval-inputs.js";

const REPRESENTATION = EXAMPLE.id(20);
const OTHER_REPRESENTATION = EXAMPLE.id(21);
const node = (n: number, representationId: string, text: string) => ({
  id: EXAMPLE.id(n),
  tenantId: EXAMPLE.tenantId,
  digest: EXAMPLE.digest("a"),
  schemaVersion: "v1",
  createdAt: EXAMPLE.at,
  representationId,
  ordinal: 0,
  kind: "paragraph",
  text,
  locator: { representationId },
});
const NODE_NOTE =
  "Each node carries id, tenantId, digest, schemaVersion 'v1', createdAt, representationId, ordinal, kind, text and a locator whose representationId names the same representation.";
const PROFILE_NOTE =
  "A profile is named by profileName and profileVersion; knowledge_chunk_strategies lists the advertised ones. An unknown profile is accepted here and fails when the operation runs.";

const ChunkingProceduresSchema = z.strictObject({
  items: z.array(z.strictObject({ id: z.string(), version: z.string(), admitted: z.boolean() })),
  nextCursor: z.null(),
});

/** Conversion, comparison, review and chunking of captured documents. */
export const PREPARATION_OPERATIONS: readonly OperationContract[] = [
  {
    operation: "transformation",
    kind: "transformation",
    effect: "submit",
    summary: "Convert the bytes of a finished capture into a document with structural nodes, and open it for review.",
    when: "Use after knowledge_source_fetch succeeded; knowledge_document_compare only compares node lists you already hold.",
    returns:
      "Returns the accepted operation; poll knowledge_promotion_status. Next a reviewer decides on the result and knowledge_chunk_build chunks it.",
    input: TransformationInputSchema,
    shape: "envelope",
    notes: [
      "captureOperationId is the operationId of a finished capture operation, not a capture id.",
      "profile.mediaType must equal the media type of the captured bytes.",
      "providerRoute lists converter keys in the order to try; a key the worker has not configured fails the operation. The converters the worker composes are deterministic-structural-text, docling-serve and, when configured, unstructured-transform.",
      "Leave a2a out: it is filled by the service for tasks that arrive through the agent-to-agent route.",
    ],
    example: {
      schemaVersion: "knowledge.transformation/v1",
      captureOperationId: EXAMPLE.id(10),
      document: { documentKind: "web_page", canonicalTitle: "Durable agent state", versionLabel: "2026-01-15" },
      profile: {
        profileKey: "structural-text",
        version: "1.0.0",
        mediaType: "text/html",
        managedProcessingAllowed: false,
      },
      providerRoute: ["deterministic-structural-text"],
    },
    result: acceptedResult(
      "On success the convert step records { schemaVersion: 'knowledge.transformation-result/v1', the stored document, version and structural representation ids and digests, reviewSubjectId, requiresReview: true } and the inspect step records { schemaVersion: 'knowledge.representation-inspection/v1', representationId, nodeCount, conversionGrade, artifactDigest, artifactDigestVerified, acceptanceState, requiresReview: true, publishable: false }.",
    ),
    related: [
      "tool:knowledge_source_fetch",
      "operation:representation_decision",
      "tool:knowledge_chunk_build",
      "tool:knowledge_promotion_status",
    ],
    mcp: ["knowledge_document_convert"],
    cli: ["knowledge document convert"],
    http: ["POST /v1/transformations"],
  },
  {
    operation: "representation_comparison",
    kind: "representation_comparison",
    effect: "submit",
    summary: "Compare two versions of a document's nodes and report which were added, removed or changed.",
    when: "Use to judge a re-conversion against the earlier one; you supply both node lists, nothing is read from storage.",
    returns:
      "Returns the accepted operation; poll knowledge_promotion_status. Its output says whether the two sides are identical and lists the differences.",
    input: RepresentationComparisonInputSchema,
    shape: "envelope",
    notes: [
      NODE_NOTE,
      "Each side holds at most 10000 nodes; node ids must be unique within a side and every node must belong to its side's representationId.",
      "Nodes are matched by position (parent path, ordinal, kind, role and locator), then compared by digest. A parentId must name a node on the same side.",
    ],
    example: {
      schemaVersion: "knowledge.representation-comparison/v1",
      left: {
        representationId: REPRESENTATION,
        digest: EXAMPLE.digest("b"),
        nodes: [node(30, REPRESENTATION, "Agents checkpoint their state.")],
      },
      right: {
        representationId: OTHER_REPRESENTATION,
        digest: EXAMPLE.digest("c"),
        nodes: [node(31, OTHER_REPRESENTATION, "Agents checkpoint their state after every step.")],
      },
    },
    result: acceptedResult(
      "On success the step records { schemaVersion: 'knowledge.representation-comparison-result/v1', leftRepresentationId, rightRepresentationId, identical, addedAlignmentKeys, removedAlignmentKeys, changedNodes: [{ alignmentKey, leftNodeId, rightNodeId, leftDigest, rightDigest }], comparisonDigest }.",
    ),
    related: ["tool:knowledge_document_convert", "tool:knowledge_chunk_compare", "tool:knowledge_promotion_status"],
    mcp: ["knowledge_document_compare"],
    cli: ["knowledge document compare"],
    http: ["POST /v1/representations/{resourceId}:compare"],
  },
  {
    operation: "representation_decision",
    kind: "representation_decision",
    effect: "submit",
    summary: "Record a reviewer's decision on one converted document representation.",
    when: "Use as the human review step after a conversion; agents cannot record it and it has no MCP tool.",
    returns:
      "Returns the accepted operation. Its output has the decisionId that a promotion proposal names as representationDecisionId.",
    input: RepresentationDecisionInputSchema,
    shape: "envelope",
    notes: [
      "The caller must be a human, or a service with the human_reviewer identity, holding the decision.record permission; a model is refused when the operation runs.",
      "reviewSubjectId and guardedDigest come from the conversion result: guardedDigest is the digest of the reviewed structural artifact.",
      "expiresAt, when given, is a UTC timestamp ending in Z.",
    ],
    example: {
      schemaVersion: "knowledge.representation-decision/v1",
      representationId: REPRESENTATION,
      reviewSubjectId: EXAMPLE.id(22),
      guardedDigest: EXAMPLE.digest("b"),
      decision: "accept",
      policyVersion: "review-policy/1",
      rationale: "The nodes match the source page.",
    },
    result: acceptedResult(
      "On success the step records { schemaVersion: 'knowledge.representation-decision-result/v1', decisionId, representationId, decision, guardedDigest, reviewDecisionId }.",
    ),
    related: ["tool:knowledge_document_convert", "tool:knowledge_promotion_propose", "operation:review_decision"],
    mcp: [],
    cli: [],
    http: ["POST /v1/representations/{resourceId}:decide"],
  },
  {
    operation: "chunk_preview",
    kind: "chunk_preview",
    effect: "submit",
    summary: "Chunk the nodes you supply with one profile and report the chunks without storing them.",
    when: "Use to try a profile before knowledge_chunk_build stores a chunk set; use knowledge_chunk_compare for several profiles.",
    returns:
      "Returns the accepted operation; poll knowledge_promotion_status. Its output has the chunks, the omitted nodes and the quality check.",
    input: ChunkPreviewInputSchema,
    shape: "envelope",
    notes: [NODE_NOTE, "nodes holds 1 to 10000 entries.", PROFILE_NOTE],
    example: {
      schemaVersion: "knowledge.chunk-preview/v1",
      nodes: [node(30, REPRESENTATION, "Agents checkpoint their state after every step.")],
      profileName: "heading-sections-v1",
      profileVersion: "1.0.0",
    },
    result: acceptedResult(
      "On success the step records { schemaVersion: 'knowledge.chunk-preview-result/v1', the profile, inputDigest, outputDigest, chunks, omitted node ids and the quality check, persisted: false }.",
    ),
    related: ["tool:knowledge_chunk_strategies", "tool:knowledge_chunk_compare", "tool:knowledge_chunk_build"],
    mcp: ["knowledge_chunk_preview"],
    cli: ["knowledge chunk preview"],
    http: ["POST /v1/chunk-previews"],
  },
  {
    operation: "chunk_comparison",
    kind: "chunk_comparison",
    effect: "submit",
    summary: "Chunk the same nodes with two to twelve profiles and report chunk and token counts for each.",
    when: "Use to choose a profile; knowledge_chunk_preview shows the chunks of one profile and neither stores anything.",
    returns: "Returns the accepted operation; poll knowledge_promotion_status. Its output has one summary per profile.",
    input: ChunkComparisonInputSchema,
    shape: "envelope",
    notes: [
      NODE_NOTE,
      "nodes holds 1 to 10000 entries; profiles holds 2 to 12 entries and no name and version pair may repeat.",
      PROFILE_NOTE,
    ],
    example: {
      schemaVersion: "knowledge.chunk-comparison/v1",
      nodes: [node(30, REPRESENTATION, "Agents checkpoint their state after every step.")],
      profiles: [
        { name: "heading-sections-v1", version: "1.0.0" },
        { name: "transcript-topics-v1", version: "1.0.0" },
      ],
    },
    result: acceptedResult(
      "On success the step records { schemaVersion: 'knowledge.chunk-comparison-result/v1', variants: [{ profile: { name, version, strategy }, inputDigest, outputDigest, chunkCount, omittedNodeCount, qa, totalSourceTokens, totalEmbeddingTokens }], comparisonDigest }.",
    ),
    related: ["tool:knowledge_chunk_strategies", "tool:knowledge_chunk_preview", "tool:knowledge_chunk_build"],
    mcp: ["knowledge_chunk_compare"],
    cli: [],
    http: ["POST /v1/chunk-comparisons"],
  },
  {
    operation: "chunk_set",
    kind: "chunk_set",
    effect: "submit",
    summary: "Chunk the stored nodes of one converted representation with one profile and store the chunk set.",
    when: "Use after knowledge_document_convert; knowledge_chunk_preview tries a profile on nodes you supply and stores nothing.",
    returns:
      "Returns the accepted operation; poll knowledge_promotion_status, then propose the chunk set with knowledge_promotion_propose.",
    input: ChunkSetInputSchema,
    shape: "envelope",
    notes: [
      "representationId is the structural representation a conversion stored; a representation without stored nodes fails the operation.",
      PROFILE_NOTE,
    ],
    example: {
      schemaVersion: "knowledge.chunk-set/v1",
      representationId: REPRESENTATION,
      profileName: "heading-sections-v1",
      profileVersion: "1.0.0",
    },
    result: acceptedResult(
      "On success the chunk step records the stored chunk set and the verify step records { schemaVersion: 'knowledge.chunk-set-verification/v1', the chunk set, reconstructable: true, promotionState: 'candidate', publishable: false }.",
    ),
    related: ["tool:knowledge_document_convert", "tool:knowledge_chunk_preview", "tool:knowledge_promotion_propose"],
    mcp: ["knowledge_chunk_build"],
    cli: ["knowledge chunk build"],
    http: ["POST /v1/chunk-sets"],
  },
  {
    operation: "chunking_procedures",
    effect: "read",
    summary: "List the chunking profiles the service advertises, with their versions.",
    when: "Use before knowledge_chunk_preview, knowledge_chunk_compare or knowledge_chunk_build to pick profileName and profileVersion.",
    returns:
      "Returns { items: [{ id, version, admitted }], nextCursor: null }; pass id as profileName and version as profileVersion.",
    input: EmptyInputSchema,
    shape: "envelope",
    notes: ["The list is fixed: heading-sections-v1 and transcript-topics-v1, both version 1.0.0."],
    example: {},
    result: {
      name: "ChunkingProcedures",
      schema: ChunkingProceduresSchema,
      outcome: "Each item is one profile; admitted is true for every listed profile.",
    },
    related: ["tool:knowledge_chunk_preview", "tool:knowledge_chunk_compare", "tool:knowledge_chunk_build"],
    mcp: ["knowledge_chunk_strategies"],
    cli: [],
    http: ["GET /v1/chunking-procedures"],
  },
];
