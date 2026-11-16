import { OperationStatusSchema } from "../integration.js";
import { OperationResultResourceSchema } from "../resources.js";
import { PromotionProposalInputSchema } from "../promotion-selection.js";
import { acceptedResult, EXAMPLE, type OperationContract } from "./contract-types.js";
import { OperationReadInputSchema } from "./retrieval-inputs.js";
import { PromotionDecisionInputSchema, ReviewDecisionInputSchema } from "./review-inputs.js";

const CHUNK = EXAMPLE.id(40);
const REVIEWER_NOTE =
  "The caller must be a human, or a service with the human_reviewer identity, holding the decision.record permission; a model is refused when the operation runs.";

/** Proposing content for promotion, the reviewer decisions that follow, and the status and result of any operation. */
export const PROMOTION_OPERATIONS: readonly OperationContract[] = [
  {
    operation: "promotion_proposal",
    kind: "promotion_proposal",
    effect: "submit",
    summary:
      "Propose selected chunks, claims or records of a chunk set for promotion into vector spaces, for a reviewer to decide.",
    when: "Use after knowledge_chunk_build and a registered selection; it publishes nothing and cannot approve its own proposal.",
    returns:
      "Returns the accepted operation; poll knowledge_promotion_status. After a reviewer accepts, embed with knowledge_embed_run.",
    input: PromotionProposalInputSchema,
    shape: "envelope",
    notes: [
      "The caller must be a model or service with the content_curator_agent identity; any other caller is refused when the operation runs.",
      "selectionArtifact names the registered selection document: its digest must be the digest of the selection, or the operation fails.",
      "selection.proposedBy and selection.requiredReviewer must differ. memberId values, and content and target pairs, must be unique.",
      "The selected members must fit the budget: their count within budget.maxMembers and their summed estimatedBytes, estimatedTokens and estimatedCostMicros within maxBytes, maxTokens and maxCostMicros.",
      "A member aimed at any space other than source_native_sections needs a target of kind entity, claim, record or summary and at least one admittedClaims entry.",
      "A member aimed at source_native_sections must be a chunk or node whose sourceChunks are not semantic_projection or retrieval_projection representations.",
      "A selected chunk must appear in its own sourceChunks with the same digest, and a chunk target must name that chunk. Content cannot be selected and excluded for the same space.",
      "contextualPrefix must be the empty string.",
    ],
    example: {
      schemaVersion: "knowledge.promotion-proposal/v1",
      selection: {
        schemaVersion: "promotion-selection.v1",
        tenantId: EXAMPLE.tenantId,
        expectedKnowledgeHead: 0,
        runPinDigest: EXAMPLE.digest("1"),
        policyDigest: EXAMPLE.digest("2"),
        selected: [
          {
            memberId: "member-1",
            content: { kind: "chunk", id: CHUNK, digest: EXAMPLE.digest("d") },
            target: { projectionTargetId: EXAMPLE.id(41), kind: "chunk", canonicalId: CHUNK },
            targetSpaces: ["source_native_sections"],
            sourceChunks: [
              {
                chunkId: CHUNK,
                chunkDigest: EXAMPLE.digest("d"),
                representationId: EXAMPLE.id(20),
                representationDigest: EXAMPLE.digest("b"),
                representationClass: "structural_extraction",
                captureId: EXAMPLE.id(42),
                sourceFamilyId: "example.com",
              },
            ],
            admittedClaims: [],
            contentLinkReceiptIds: [EXAMPLE.id(43)],
            reason: "A faithful section about checkpointing.",
            estimatedBytes: 400,
            estimatedTokens: 90,
            estimatedCostMicros: 20,
          },
        ],
        excluded: [],
        budget: { maxMembers: 1, maxBytes: 10_000, maxTokens: 2_000, maxCostMicros: 1_000, deadline: EXAMPLE.at },
        proposedBy: "content-curator-agent",
        requiredReviewer: "human-reviewer",
      },
      selectionArtifact: { id: EXAMPLE.id(44), digest: EXAMPLE.digest("e") },
      chunkSetId: EXAMPLE.id(45),
      representationDecisionId: EXAMPLE.id(46),
      projectionProcedureId: EXAMPLE.id(47),
      purpose: "Make the section retrievable.",
      contextualPrefix: "",
      visibility: "tenant",
      classification: "public",
      targetDomains: ["source_native_sections"],
      expectedValue: "Answers questions about agent checkpointing.",
      risks: [],
      exclusions: [],
      reason: "First promotion of this document.",
    },
    result: acceptedResult(
      "On success the step records { schemaVersion: 'knowledge.promotion-proposal-result/v1', proposalId, projectionIds, projectionManifestDigest, selectionDigest, proposalDigest, reviewSubjectId, requiresIndependentDecision: true, publishable: false }. The review subject is open to human reviewers.",
    ),
    related: [
      "tool:knowledge_chunk_build",
      "operation:promotion_decision",
      "tool:knowledge_embed_run",
      "tool:knowledge_promotion_status",
    ],
    mcp: ["knowledge_promotion_propose"],
    cli: ["knowledge promotion propose"],
    http: ["POST /v1/promotion-proposals"],
  },
  {
    operation: "promotion_decision",
    kind: "promotion_decision",
    effect: "submit",
    summary: "Record a reviewer's decision on one promotion proposal.",
    when: "Use as the human review step after a proposal; agents cannot record it and it has no MCP tool.",
    returns:
      "Returns the accepted operation. Its output has the decisionId that embedding and publication name as promotionDecisionId.",
    input: PromotionDecisionInputSchema,
    shape: "envelope",
    notes: [
      REVIEWER_NOTE,
      "reviewSubjectId and guardedDigest come from the proposal result: guardedDigest is its proposalDigest.",
      "gates is any JSON value recorded with the decision.",
      "expiresAt, when given, is a UTC timestamp ending in Z.",
    ],
    example: {
      schemaVersion: "knowledge.promotion-decision/v1",
      proposalId: EXAMPLE.id(48),
      reviewSubjectId: EXAMPLE.id(49),
      guardedDigest: EXAMPLE.digest("f"),
      decision: "accept",
      gates: { reviewedMembers: 1 },
      policyVersion: "review-policy/1",
      rationale: "The selected section is faithful and in scope.",
    },
    result: acceptedResult(
      "On success the step records { schemaVersion: 'knowledge.promotion-decision-result/v1', decisionId, proposalId, decision, guardedDigest, reviewDecisionId }.",
    ),
    related: ["tool:knowledge_promotion_propose", "tool:knowledge_embed_run", "operation:space_publication"],
    mcp: [],
    cli: ["knowledge promotion review"],
    http: ["POST /v1/promotion-decisions"],
  },
  {
    operation: "review_decision",
    kind: "review_decision",
    effect: "submit",
    summary: "Record a reviewer's decision on any open review subject, such as a source vetting result.",
    when: "Use for reviews that have no decision of their own; conversions and promotion proposals have dedicated decisions.",
    returns: "Returns the accepted operation. Its output has the decisionId, the review subject and the decision.",
    input: ReviewDecisionInputSchema,
    shape: "envelope",
    notes: [
      REVIEWER_NOTE,
      "reviewSubjectId and guardedDigest come from the result of the operation that opened the review.",
    ],
    example: {
      schemaVersion: "knowledge.review-decision/v1",
      reviewSubjectId: EXAMPLE.id(50),
      guardedDigest: EXAMPLE.digest("a"),
      decision: "approve",
      rationale: "Every document passed its checks.",
    },
    result: acceptedResult(
      "On success the step records { schemaVersion: 'knowledge.review-decision-result/v1', decisionId, reviewSubjectId, decision, guardedDigest }.",
    ),
    related: ["tool:knowledge_source_vet", "operation:representation_decision", "operation:promotion_decision"],
    mcp: [],
    cli: [],
    http: ["POST /v1/review-decisions"],
  },
  {
    operation: "operation_status",
    effect: "read",
    summary: "Read the state of one knowledge operation by its operationId.",
    when: "Use to poll any knowledge_* submission, not only promotion proposals; verify_* submissions are polled with verify_status.",
    returns:
      "Returns the operation status: kind, state, receiptIds and, after a failure, a failure summary. Poll while state is queued or running, then read knowledge_operation_result.",
    input: OperationReadInputSchema,
    shape: "envelope",
    notes: [
      "state is one of queued, running, needs_review, quarantined, succeeded, failed, cancelled.",
      "The status lists the receipts of finished steps (receiptIds) but not their output. knowledge_operation_result returns the identifiers and digests each step recorded; a whole receipt, with its body, is read over HTTP with GET /v1/receipts/{receiptId}.",
      "On MCP an input without a valid operationId is refused with RESOURCE_ID_REQUIRED and an unknown operation is answered with the text NOT_FOUND.",
    ],
    example: { operationId: EXAMPLE.id(2) },
    result: {
      name: "OperationStatus",
      schema: OperationStatusSchema,
      outcome:
        "failure, when present, carries the receipt id, a category, an error class and whether a retry can help.",
    },
    related: ["tool:knowledge_operation_result", "tool:knowledge_store_status", "tool:verify_status"],
    mcp: ["knowledge_promotion_status"],
    cli: ["knowledge operation status", "knowledge promotion status"],
    http: ["GET /v1/operations/{operationId}"],
  },
  {
    operation: "operation_result",
    effect: "read",
    summary: "Read what one operation produced: the identifiers and digests each finished step recorded.",
    when: "Use once knowledge_promotion_status or verify_status reports succeeded, to get the ids the next call needs.",
    returns:
      "Returns the operation's kind and state, each finished step with its recorded ids, and those ids gathered by field name in ids. Pass them to the next tool.",
    input: OperationReadInputSchema,
    shape: "envelope",
    notes: [
      "It answers for every operation of the tenant, whether a knowledge_* or a verify_* tool submitted it.",
      "A step's output keeps its identifiers, digests, timestamps, numbers, flags and short state names. Text, addresses, storage locations and provider content are left out, and omittedFields counts them. The whole receipt is read over HTTP with GET /v1/receipts/{receiptId}.",
      "ids gathers every identifier and digest of the outputs under its field name, for example representationId, chunkSetId, captureId, proposalId, reviewSubjectId or benchmarkRunId. Each name holds at most 50 distinct values, in the order they were recorded.",
      "steps is empty while no step has finished. A failed step has the outcome failed and an output with its errorClass; state says whether the operation as a whole succeeded.",
      "On MCP an input without a valid operationId is refused with RESOURCE_ID_REQUIRED and an unknown operation with NOT_FOUND.",
    ],
    example: { operationId: EXAMPLE.id(2) },
    result: {
      name: "OperationResultResource",
      schema: OperationResultResourceSchema,
      outcome:
        "After a document conversion, ids.representationId is the representation knowledge_chunk_build takes; after a chunk build, ids.chunkSetId is the chunk set knowledge_promotion_propose takes; after a proposal, ids.projectionIds are the projections knowledge_embed_run takes.",
    },
    related: ["tool:knowledge_promotion_status", "tool:verify_status", "tool:knowledge_store_status"],
    mcp: ["knowledge_operation_result"],
    cli: ["knowledge operation result"],
    http: ["GET /v1/operations/{operationId}/result"],
  },
];
