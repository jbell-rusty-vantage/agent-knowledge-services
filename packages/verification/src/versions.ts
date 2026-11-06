/**
 * Protocol version literals owned by this package.
 *
 * Every value here is written into retained records and participates in
 * digests, signatures and replay comparisons. They identify an algorithm
 * revision, not a deployment: they must never be read from configuration or
 * the environment, and changing one is a contract change that invalidates
 * previously sealed artifacts.
 */

/** Contract version stamped on deterministic results and audit bundles. */
export const VERIFICATION_CONTRACT_VERSION = "verification.v1" as const;

/** Resolver that owns text quote, character position, JSON pointer and multi-fragment selectors. */
export const CORE_RESOLVER_VERSION = "verification-core.v1" as const;

/** Resolver that owns canonical-projection selectors (HTML, PDF, geometry, table, media, repository, dataset, API). */
export const PROJECTION_RESOLVER_VERSION = "verification-projections.v1" as const;

/** Extraction schema admission gate. */
export const EXTRACTION_SCHEMA_GATE_VERSION = "verification-extraction-schema.v1" as const;

export const CLAIM_DECOMPOSITION_SCHEMA_VERSION = "verification-claim-decomposition.v1" as const;

export const EXTRACTION_FIELD_EVIDENCE_SCHEMA_VERSION = "verification-extraction-field-evidence.v1" as const;

export const EXTRACTION_FIELD_FRAGMENT_SCHEMA_VERSION = "verification-extraction-field-fragment.v1" as const;

export const CROSS_FIELD_TOTAL_SCHEMA_VERSION = "verification-cross-field-total.v1" as const;

/** Output schema every semantic judge must return. */
export const SEMANTIC_JUDGE_SCHEMA_VERSION = "verification-semantic-judge.v1" as const;

/** Rubric under which semantic judges are graded: evidence only, no world knowledge. */
export const SEMANTIC_RUBRIC_VERSION = "evidence-only.v1" as const;

export const SEMANTIC_RESPONSE_OBSERVATION_SCHEMA_VERSION = "verification-semantic-response-observation.v1" as const;

export const REPORT_RESULT_SCHEMA_VERSION = "verification-report-result.v1" as const;
