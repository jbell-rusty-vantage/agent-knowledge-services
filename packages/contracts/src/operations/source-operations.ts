import { acceptedResult, type OperationContract } from "./contract-types.js";
import {
  CaptureInputSchema,
  SourceDiscoveryInputSchema,
  SourceResolutionInputSchema,
  SourceVettingInputSchema,
} from "./source-inputs.js";

/** Finding, identifying, capturing and vetting sources. */
export const SOURCE_OPERATIONS: readonly OperationContract[] = [
  {
    operation: "source_discovery",
    kind: "source_discovery",
    effect: "submit",
    summary: "Rank and deduplicate candidate source URLs you already collected; it does not search the web.",
    when: "Use first, to choose what to capture; use knowledge_source_resolve when you need canonical identifiers.",
    returns:
      "Returns the accepted operation; poll knowledge_promotion_status, then fetch a candidate with knowledge_source_fetch.",
    input: SourceDiscoveryInputSchema,
    shape: "envelope",
    notes: [
      "candidates holds at most 500 entries; score is your own relevance estimate from 0 to 1.",
      "limit is the number of ranked candidates kept: 1 to 100, 25 when omitted.",
      "Candidates whose URLs are equal after normalization (fragment removed, host lower-cased, default port removed, query sorted) are merged and the highest score is kept.",
    ],
    example: {
      schemaVersion: "knowledge.source-discovery/v1",
      query: "durable agent state",
      candidates: [
        {
          url: "https://example.com/agents/state",
          title: "Durable agent state",
          sourceClass: "web_page",
          score: 0.9,
          evidence: ["the page describes checkpointing"],
        },
      ],
    },
    result: acceptedResult(
      "On success the step records { schemaVersion: 'knowledge.source-discovery-result/v1', query, candidateCount, candidates: [{ url, title, sourceClass, publisher?, score, evidence, candidateId, rank, candidateDigest }], resultDigest }, ordered by score and then URL.",
    ),
    related: ["tool:knowledge_source_resolve", "tool:knowledge_source_fetch", "tool:knowledge_promotion_status"],
    mcp: ["knowledge_source_discover"],
    cli: ["knowledge source discover"],
    http: ["POST /v1/sources:discover"],
  },
  {
    operation: "source_resolution",
    kind: "source_resolution",
    effect: "submit",
    summary: "Turn URLs, DOIs, arXiv ids and OpenReview ids into canonical identifiers and stable source ids.",
    when: "Use when two candidates may be the same source; it fetches nothing, unlike knowledge_source_fetch.",
    returns:
      "Returns the accepted operation; poll knowledge_promotion_status. Its output has one canonical identifier per candidate.",
    input: SourceResolutionInputSchema,
    shape: "envelope",
    notes: [
      "candidates holds 1 to 500 entries and every candidateId must be different; a repeated candidateId fails the operation when it runs.",
      "identifier is a URL when identifierKind is url, and the bare identifier otherwise.",
    ],
    example: {
      schemaVersion: "knowledge.source-resolution/v1",
      candidates: [{ candidateId: "candidate-1", identifierKind: "arxiv", identifier: "2401.00001" }],
    },
    result: acceptedResult(
      "On success the step records { schemaVersion: 'knowledge.source-resolution-result/v1', resolvedCount, resolved: [{ candidateId, identifierKind, identifier, canonicalIdentifier, sourceId, resolutionDigest }], resultDigest }, ordered by candidateId.",
    ),
    related: ["tool:knowledge_source_discover", "tool:knowledge_source_fetch", "tool:knowledge_promotion_status"],
    mcp: ["knowledge_source_resolve"],
    cli: [],
    http: ["POST /v1/sources:resolve"],
  },
  {
    operation: "capture",
    kind: "capture",
    effect: "submit",
    summary: "Fetch one HTTP source or staged upload and store its bytes sealed under a digest.",
    when: "Use to bring a source into the service; discovery and resolution only rank and name sources.",
    returns:
      "Returns the accepted operation; poll knowledge_promotion_status, then convert it with knowledge_document_convert (captureOperationId = this operationId).",
    input: CaptureInputSchema,
    shape: "envelope",
    notes: [
      "For an http target, source.canonicalUrl and request.target.url must be the same URL.",
      "source.sensitivity must equal request.classification.",
      "request.maximumBytes is in bytes, at most 1073741824 (1 GiB).",
      "request.egressProfile has one admitted value, public-web-v1.",
      "A target the deployment cannot acquire is accepted here and fails when the operation runs (ACQUISITION_ROUTE_UNSUPPORTED).",
    ],
    example: {
      schemaVersion: "knowledge.capture/v1",
      source: { sourceClass: "web_page", canonicalUrl: "https://example.com/agents/state", sensitivity: "public" },
      request: {
        purpose: "capture the page for preparation",
        target: { kind: "http", url: "https://example.com/agents/state" },
        expectedSourceClass: "web_page",
        preferredMediaTypes: ["text/html"],
        egressProfile: "public-web-v1",
        maximumBytes: 5_000_000,
        renderingPolicy: "none",
        interactionPolicy: "none",
        classification: "public",
        expectedOutputs: ["source_capture"],
      },
    },
    result: acceptedResult(
      "On success the acquire step records { schemaVersion: 'knowledge.capture-result/v1', sourceId, captureId, artifact, contentDigests, verification, observations, capturedAt } and the seal step records { schemaVersion: 'knowledge.capture-seal/v1', captureId, artifactId, digest, sizeBytes, byteIdentityVerified: true }.",
    ),
    related: ["tool:knowledge_source_discover", "tool:knowledge_document_convert", "tool:knowledge_promotion_status"],
    mcp: ["knowledge_source_fetch"],
    cli: ["knowledge source fetch"],
    http: ["POST /v1/captures"],
  },
  {
    operation: "source_vetting",
    kind: "source_vetting",
    effect: "submit",
    summary: "Check a bundle of selected documents and claims and open a review of the result for a human reviewer.",
    when: "Use on an embedding bundle before preparing it; it checks URLs, text, entity anchors and target spaces, not truth.",
    returns:
      "Returns the accepted operation; poll knowledge_promotion_status. Its output has per-document findings and a reviewSubjectId.",
    input: SourceVettingInputSchema,
    shape: "envelope",
    notes: [
      "The input is the embedding bundle itself, with snake_case field names.",
      "store_class has one admitted value, internal_exploratory; research_as_of is a calendar date (YYYY-MM-DD).",
      "A document is accepted when canonical_url is an http or https URL, text is not blank, entity_slugs is not empty and every target_vector_spaces entry is a known space.",
    ],
    example: {
      schema_version: "ai-engineer-embedding-bundle/0.1.0",
      store_class: "internal_exploratory",
      video_id: "video-1",
      title: "Durable agent state",
      research_as_of: "2026-01-15",
      primary: {
        engineer: { slug: "example-engineer", display_name: "Example Engineer" },
        organization: { slug: "example-org", display_name: "Example Org" },
      },
      selected_documents: [
        {
          id: "document-1",
          document_kind: "transcript",
          title: "Durable agent state",
          canonical_url: "https://example.com/agents/state",
          source_role: "primary",
          publisher: "Example Org",
          source_class: "transcript",
          target_vector_spaces: ["source_native_sections"],
          text: "Agents checkpoint their state after every step.",
          entity_slugs: ["example-org"],
        },
      ],
      engineering_claims: [],
    },
    result: acceptedResult(
      "On success the step records { bundleDigest, accepted, findings: [{ documentId, accepted, checks, findings, intendedSpaces }], proposals, reviewSubjectId }. The review subject is open to human reviewers.",
    ),
    related: ["tool:knowledge_source_fetch", "tool:knowledge_promotion_status", "operation:review_decision"],
    mcp: ["knowledge_source_vet"],
    cli: ["knowledge source vet"],
    http: ["POST /v1/captures/{resourceId}:vet"],
  },
];
