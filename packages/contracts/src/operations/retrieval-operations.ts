import { RetrievalExplanationResourceSchema, RetrievalRunResourceSchema } from "../resources.js";
import {
  EvidencePacketSchema,
  RetrievalCitationReplaySchema,
  RetrievalPlanSchema,
  RetrievalRunInputSchema,
} from "../retrieval.js";
import { acceptedResult, EXAMPLE, type OperationContract } from "./contract-types.js";
import {
  EvidencePacketInputSchema,
  EvidencePacketReadInputSchema,
  RetrievalPlanValidationInputSchema,
  RetrievalRunReadInputSchema,
} from "./retrieval-inputs.js";

const RUN = EXAMPLE.id(2);
const PACKET = EXAMPLE.id(81);
const PLAN = {
  policyVersion: EXAMPLE.id(80),
  query: "durable agent state",
  intents: ["knowledge_evidence"],
  subqueries: [{ id: "q1", text: "durable agent state", coverageRole: "required" }],
  spaces: ["engineering_claims"],
  anchors: { entities: [], concepts: [], useCases: [] },
  hardFilters: [],
  softBoosts: [],
  temporalScope: {},
  candidateK: 10,
  finalK: 5,
  graph: { maxDepth: 0, allowedEdges: [] },
  abstention: { minimumCoverage: 1 },
};
const PLAN_NOTES = [
  "finalK cannot exceed candidateK; spaces, subquery ids, entity anchors and optionalCapabilities must not repeat, and at most 64 entity anchors are accepted.",
  "Three clocks stay separate: temporalScope filters by when the corpus captured the material, worldScope by when the stated fact holds, and knowledgeScope.atKnowledgeSeq by the tenant's knowledge sequence (the current one when omitted).",
  "Timestamps carry a zone offset and at most six fractional digits; effectiveAfter must precede effectiveBefore and observedBefore, and a worldScope of kind overlap needs from before to.",
  "A plan may be sent as { plan } or, on MCP and the CLI, as the plan itself.",
];
const ID_READ_NOTE = (field: string) =>
  `On MCP an input that is not exactly { ${field} } with a valid id is refused with RESOURCE_ID_REQUIRED.`;

/** Retrieval plans and runs, their explanations, and evidence packets. */
export const RETRIEVAL_OPERATIONS: readonly OperationContract[] = [
  {
    operation: "retrieval_run",
    kind: "retrieval_run",
    effect: "submit",
    summary: "Run one retrieval plan now: search the plan's spaces and store the run with its evidence packet.",
    when: "Use to get evidence for a query; knowledge_retrieve_plan only checks a plan and searches nothing.",
    returns:
      "Returns the accepted operation once the search is stored; read it with knowledge_retrieve_run (runId = this operationId), then knowledge_retrieve_packet.",
    input: RetrievalRunInputSchema,
    shape: "envelope",
    notes: [
      ...PLAN_NOTES,
      "The service embeds the query; no vector is sent.",
      "A plan that needs a capability the deployment lacks (graph, concept_anchors, use_case_anchors, soft_boosts, context, freshness_upper_bound, observed_upper_bound) is refused with RETRIEVAL_CAPABILITY_UNSUPPORTED and the list; naming the capability in optionalCapabilities turns it into a recorded omission.",
      'Over HTTP expectedVersions must contain "retrieval": "v1"; the MCP tool and the CLI add it.',
      "Leave a2a out: it is filled by the service for tasks that arrive through the agent-to-agent route.",
    ],
    example: { plan: PLAN },
    result: acceptedResult(
      "The search runs before the call returns. The stored run has the id of the operation; its evidence packet lists the members found, coverage per subquery and whether abstaining is recommended.",
    ),
    related: [
      "tool:knowledge_retrieve_plan",
      "tool:knowledge_retrieve_run",
      "tool:knowledge_retrieve_explain",
      "tool:knowledge_retrieve_packet",
    ],
    mcp: ["knowledge_retrieve_search"],
    cli: ["knowledge retrieve search"],
    http: ["POST /v1/retrieval-runs"],
  },
  {
    operation: "retrieval_plan_validation",
    effect: "read",
    summary: "Check a retrieval plan against the plan contract and return it as the service reads it.",
    when: "Use before knowledge_retrieve_search to catch a malformed plan; it searches nothing and stores nothing.",
    returns:
      "Returns the validated plan, or INVALID_CONTRACT with the failing fields. Then run it with knowledge_retrieve_search.",
    input: RetrievalPlanValidationInputSchema,
    shape: "envelope",
    notes: [
      ...PLAN_NOTES,
      "Validation checks the shape and the cross-field rules only: it does not check that policyVersion is active or that the spaces are published.",
    ],
    example: { plan: PLAN },
    result: {
      name: "RetrievalPlan",
      schema: RetrievalPlanSchema,
      outcome: "The plan with surrounding whitespace removed from its texts.",
    },
    related: ["tool:knowledge_retrieve_search"],
    mcp: ["knowledge_retrieve_plan"],
    cli: ["knowledge retrieve plan"],
    http: ["POST /v1/retrieval-plans:validate"],
  },
  {
    operation: "retrieval_run_read",
    effect: "read",
    summary: "Read one stored retrieval run: its plan record, stage timings, fusion settings and evidence packet ids.",
    when: "Use after knowledge_retrieve_search to find the packet; knowledge_retrieve_explain shows why each candidate ranked.",
    returns: "Returns the run with evidencePacketIds; read a packet with knowledge_retrieve_packet.",
    input: RetrievalRunReadInputSchema,
    shape: "envelope",
    notes: ["runId is the operationId of the retrieval run.", ID_READ_NOTE("runId")],
    example: { runId: RUN },
    result: {
      name: "RetrievalRunResource",
      schema: RetrievalRunResourceSchema,
      outcome: "evidencePacketIds holds at most 100 ids.",
    },
    related: ["tool:knowledge_retrieve_search", "tool:knowledge_retrieve_explain", "tool:knowledge_retrieve_packet"],
    mcp: ["knowledge_retrieve_run"],
    cli: ["knowledge retrieve run"],
    http: ["GET /v1/retrieval-runs/{runId}"],
  },
  {
    operation: "retrieval_explanation",
    effect: "read",
    summary:
      "Read why a retrieval run ranked its candidates: stage scores, final score, rank and the channels that found each one.",
    when: "Use to debug a ranking; knowledge_retrieve_packet returns the evidence itself.",
    returns: "Returns at most 100 candidates with their sources per channel; truncated says whether more exist.",
    input: RetrievalRunReadInputSchema,
    shape: "envelope",
    notes: [
      "runId is the operationId of the retrieval run.",
      "A source channel is one of vector, lexical, exact, graph, rerank.",
      "On MCP an input without a valid runId is refused with RESOURCE_ID_REQUIRED.",
    ],
    example: { runId: RUN },
    result: {
      name: "RetrievalExplanationResource",
      schema: RetrievalExplanationResourceSchema,
      outcome: "Each candidate carries stageScores, an optional finalScore and rank, and its sources.",
    },
    related: ["tool:knowledge_retrieve_run", "tool:knowledge_retrieve_packet"],
    mcp: ["knowledge_retrieve_explain"],
    cli: ["knowledge retrieve explain"],
    http: ["GET /v1/retrieval-runs/{runId}/explanation"],
  },
  {
    operation: "evidence_packet_read",
    effect: "read",
    summary:
      "Read one stored evidence packet: its members with source locators and scores, coverage and abstention advice.",
    when: "Use to get the evidence of a retrieval run; knowledge_retrieve_citations re-reads the cited source text.",
    returns:
      "Returns the evidence packet. Check abstention.recommended before using the members; replay citations with knowledge_retrieve_citations.",
    input: EvidencePacketReadInputSchema,
    shape: "envelope",
    notes: ["packetId comes from evidencePacketIds of the retrieval run.", ID_READ_NOTE("packetId")],
    example: { packetId: PACKET },
    result: {
      name: "EvidencePacket",
      schema: EvidencePacketSchema,
      outcome:
        "Each member names a canonical record or a faithful section, its locators, score components, authority and assurance.",
    },
    related: ["tool:knowledge_retrieve_run", "tool:knowledge_retrieve_citations"],
    mcp: ["knowledge_retrieve_packet"],
    cli: ["knowledge retrieve packet"],
    http: ["GET /v1/evidence-packets/{packetId}"],
  },
  {
    operation: "citation_replay",
    effect: "read",
    summary:
      "Fetch the stored source bytes behind each citation of an evidence packet and return the selected text again.",
    when: "Use to confirm that a packet's citations still resolve; knowledge_retrieve_packet returns the packet without re-reading sources.",
    returns:
      "Returns at most 128 replayed citations with their text and digests, and the citations that failed with a code each.",
    input: EvidencePacketReadInputSchema,
    shape: "envelope",
    notes: [
      "The deployment needs storage custody of the cited sources; without it the read is refused (CAPABILITY_NOT_ADMITTED on MCP, status 503 over HTTP).",
      ID_READ_NOTE("packetId"),
    ],
    example: { packetId: PACKET },
    result: {
      name: "RetrievalCitationReplay",
      schema: RetrievalCitationReplaySchema,
      outcome: "A citation that could not be replayed appears in failures, never as silently missing text.",
    },
    related: ["tool:knowledge_retrieve_packet"],
    mcp: ["knowledge_retrieve_citations"],
    cli: ["knowledge retrieve citations"],
    http: ["GET /v1/evidence-packets/{packetId}/citations"],
  },
  {
    operation: "evidence_packet",
    kind: "evidence_packet",
    effect: "submit",
    summary: "Store one complete evidence packet that you assembled, under its plan and run ids.",
    when: "Use only for a packet built outside the service; knowledge_retrieve_search already stores the packet of its own run.",
    returns:
      "Returns the accepted operation; poll knowledge_promotion_status. Read the stored packet with knowledge_retrieve_packet.",
    input: EvidencePacketInputSchema,
    shape: "envelope",
    notes: [
      "packet is a full evidence packet, including its plan, which follows the retrieval plan rules.",
      "Every member needs a canonicalRecord or a faithfulSectionRepresentationId, and at least one locator; in a locator endOffset must exceed startOffset and endTimeMs must exceed startTimeMs.",
      "Leave a2a out: it is filled by the service for tasks that arrive through the agent-to-agent route.",
      "It has no HTTP route of its own: over HTTP it is submitted through POST /v1/operations with kind evidence_packet, or as an agent-to-agent task of kind evidence_packet_construction.",
    ],
    example: {
      planId: EXAMPLE.id(82),
      runId: RUN,
      packetId: PACKET,
      packet: {
        id: PACKET,
        tenantId: EXAMPLE.tenantId,
        digest: EXAMPLE.digest("a"),
        schemaVersion: "v1",
        createdAt: EXAMPLE.at,
        retrievalRunId: RUN,
        normalizedQuery: "durable agent state",
        plan: PLAN,
        authorization: {
          decisionId: EXAMPLE.id(83),
          tenantId: EXAMPLE.tenantId,
          actorId: EXAMPLE.id(4),
          action: "knowledge.read",
          resource: "evidence_packet",
          allowed: true,
          policyVersion: EXAMPLE.id(80),
          reasonCodes: ["tenant_grant"],
        },
        procedureVersionIds: [],
        members: [],
        omittedResults: [],
        coverage: [{ subqueryId: "q1", coverage: 0 }],
        abstention: { recommended: true, reason: "no members" },
        eventIds: [],
        artifactIds: [],
        receiptIds: [],
      },
    },
    result: acceptedResult("On success the step records { packetId, digest, persisted: true }."),
    related: ["tool:knowledge_retrieve_search", "tool:knowledge_retrieve_packet", "tool:knowledge_promotion_status"],
    mcp: ["knowledge_retrieve_build_packet"],
    cli: [],
    http: [],
  },
];
