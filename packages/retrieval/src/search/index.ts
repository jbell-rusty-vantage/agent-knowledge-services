// Pipeline — retrieve(): stage sequencing, diversity cap, context radius, coverage,
// abstention, and immutable evidence-packet assembly. The one orchestrator; every
// stage folder below is a primitive it calls, none is public on its own.
export { retrieve } from "./retrieve.js";

// Plan — policy-scoped query plan assembly (space/filter admission, subquery
// decomposition, intent inference).
export { buildRetrievalPlan } from "./plan/index.js";

// Space admission — ALL_SPACES, inferSpaces, assertAdmittedSpaces. Internal to the
// pipeline; the public surface never named them, so this package does not either.

// Lexical — exact/trigram/fts channel scoring. Internal.

// Semantic — cosine similarity scoring. Internal.

// Graph — verified-edge expansion. Internal.

// Rerank — RRF fusion and candidate tie-break comparison. Internal.

// Types — the retrieval contract this package promises callers. Kept as a single
// re-export list so the public surface can be diffed against dist/index.d.ts in one
// place (see docs/operations/reviews/retrieval.md).
export type {
  AdvancedRetrievalPlan,
  EvidenceMember,
  FilterValue,
  GraphEdge,
  ImmutableEvidencePacket,
  Reranker,
  RetrievalChannel,
  RetrievalFilter,
  RetrievalFlags,
  RetrievalIntent,
  RetrievalPolicy,
  RetrievalRecord,
  RetrievalStages,
  RetrievalSubquery,
  RetrievedCandidate,
  RetrieveOptions,
  StageContribution,
} from "./types.js";
