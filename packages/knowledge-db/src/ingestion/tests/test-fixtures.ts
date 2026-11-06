import type { IngestionIntentInput } from "../intent.js";
import type { PlanFacts } from "../plan.js";
import { NO_RULES } from "../rules.js";
import type { Vocabulary } from "../vocabulary.js";

/** In-memory vocabulary mirroring the km_01 rows the planner tests exercise. */
export const ALL_KINDS = ["organization", "ai_model", "ai_model_version", "model_offering", "person"];

export const fixtureVocabulary: Vocabulary = {
  entityKinds: new Map([
    [
      "organization",
      {
        code: "organization",
        schema: "corpus",
        table: "organization",
        columns: ["legal_name", "website_url", "country_code", "founded_on"],
      },
    ],
    [
      "ai_model",
      { code: "ai_model", schema: "corpus", table: "ai_model", columns: ["model_family", "modality", "description"] },
    ],
    [
      "ai_model_version",
      {
        code: "ai_model_version",
        schema: "corpus",
        table: "ai_model_version",
        columns: ["ai_model_id", "version_label", "provider_model_id"],
      },
    ],
    [
      "model_offering",
      {
        code: "model_offering",
        schema: "corpus",
        table: "model_offering",
        columns: ["model_version_id", "provider_entity_id", "offering_key"],
      },
    ],
    ["person", { code: "person", schema: "corpus", table: "person", columns: ["given_name", "family_name", "orcid"] }],
  ]),
  relationshipKinds: new Map([
    [
      "offered_as",
      {
        code: "offered_as",
        fromKinds: ["ai_model_version"],
        toKinds: ["model_offering"],
        temporal: false,
        propertySchema: {},
      },
    ],
    [
      "develops",
      {
        code: "develops",
        fromKinds: ["organization"],
        toKinds: ["product", "ai_model"],
        temporal: true,
        propertySchema: {},
      },
    ],
  ]),
  streamKinds: new Map([
    [
      "entity_name",
      {
        code: "entity_name",
        subjectMode: "entity",
        subjectKinds: ALL_KINDS,
        statusValues: null,
        requiresAmount: false,
        unitValues: null,
        requiresRefEntity: false,
        payloadSchema: { type: "object", required: ["display_name"] },
      },
    ],
    [
      "model_offering_price",
      {
        code: "model_offering_price",
        subjectMode: "entity",
        subjectKinds: ["model_offering"],
        statusValues: null,
        requiresAmount: true,
        unitValues: ["per_1m_input_tokens", "per_1m_output_tokens"],
        requiresRefEntity: false,
        payloadSchema: {},
      },
    ],
    [
      "model_offering_availability",
      {
        code: "model_offering_availability",
        subjectMode: "entity",
        subjectKinds: ["model_offering"],
        statusValues: ["announced", "preview", "ga", "deprecated", "retired"],
        requiresAmount: false,
        unitValues: null,
        requiresRefEntity: false,
        payloadSchema: {},
      },
    ],
    [
      "organization_status",
      {
        code: "organization_status",
        subjectMode: "entity",
        subjectKinds: ["organization"],
        statusValues: ["operating", "acquired", "merged", "dissolved", "stealth"],
        requiresAmount: false,
        unitValues: null,
        requiresRefEntity: false,
        payloadSchema: {},
      },
    ],
  ]),
  eventKinds: new Map([
    [
      "model_version_released",
      { code: "model_version_released", subjectKinds: ["ai_model_version"], objectKinds: ALL_KINDS },
    ],
  ]),
};

export const TENANT = "00000000-0000-7000-8000-000000000001";
export const OPENAI = "0192b000-0000-7000-8000-000000000001";
export const GPT_VERSION = "0192b000-0000-7000-8000-000000000102";

export function priceIntent(overrides: Partial<IngestionIntentInput> = {}): IngestionIntentInput {
  return {
    schemaVersion: "knowledge-ingestion-intent.v1",
    intentId: "openai-products-2026-09-11",
    context: { tenantId: TENANT, correlationId: "exp3-a-r1", actor: { kind: "agent", id: "eve:db-aware-research" } },
    inputSnapshot: { snapshotId: "snap-1", snapshotDigest: "sha256:5e1", knowledgeSeq: 41 },
    expectedKnowledgeHead: 41,
    onStale: "rebase_if_disjoint",
    asOf: "2026-09-11",
    evidence: { verificationRuns: [{ runId: "vr_01", manifestDigest: "sha256:c0d" }] },
    subjects: [
      { ref: "gpt-5.6", mode: "resolved", entityId: GPT_VERSION, kind: "ai_model_version" },
      {
        ref: "gpt-5.6-terra-offering",
        mode: "new",
        kind: "model_offering",
        displayName: "GPT-5.6 Terra (API)",
        aliases: [{ alias: "gpt-5.6-terra", aliasKind: "model_alias" }],
        identifiers: [{ scheme: "other", value: "openai:gpt-5.6-terra" }],
        typedPayload: { model_version_id: "$subject:gpt-5.6", provider_entity_id: OPENAI, offering_key: "api" },
        onMatch: "review",
        evidence: [{ runId: "vr_01", claimId: "c_0007" }],
      },
    ],
    proposals: [
      {
        proposalId: "p-01",
        kind: "relationship.assert",
        relationshipKind: "offered_as",
        fromRef: "gpt-5.6",
        toRef: "gpt-5.6-terra-offering",
        temporalBasis: "observation_bounded",
        evidence: [{ runId: "vr_01", claimId: "c_0007" }],
      },
      {
        proposalId: "p-02",
        kind: "fact.assert_state",
        subjectRef: "gpt-5.6-terra-offering",
        streamKind: "model_offering_availability",
        worldInterval: { from: "2026-08-20T00:00:00Z", to: null, bounds: "[)" },
        status: "ga",
        extent: { sourceText: "August 20, 2026", precision: "day", earliest: "2026-08-20", latest: "2026-08-20" },
        temporalBasis: "explicit",
        evidence: [{ runId: "vr_01", claimId: "c_0009" }],
      },
      {
        proposalId: "p-03",
        kind: "fact.assert_state",
        subjectRef: "gpt-5.6-terra-offering",
        streamKind: "model_offering_price",
        worldInterval: { from: "2026-08-20T00:00:00Z", to: null, bounds: "[)" },
        amount: 2.5,
        currency: "USD",
        unit: "per_1m_input_tokens",
        temporalBasis: "observation_bounded",
        evidence: [{ runId: "vr_01", claimId: "c_0011" }],
      },
    ],
    notes: "excluded from the idempotency key",
    ...overrides,
  };
}

export function fixtureFacts(overrides: Partial<PlanFacts> = {}): PlanFacts {
  return {
    currentHead: 41,
    vocabulary: fixtureVocabulary,
    subjects: {
      "gpt-5.6": { ref: "gpt-5.6", kind: "ai_model_version", lifecycle: "active", mergedInto: null },
      "gpt-5.6-terra-offering": {
        ref: "gpt-5.6-terra-offering",
        kind: "model_offering",
        matches: [],
        slugTaken: false,
      },
    },
    existing: { segments: {}, relationships: {}, occurrences: {}, seriesKeys: {} },
    claims: ["c_0007", "c_0009", "c_0011"].map((claimId) => ({
      runId: "vr_01",
      claimId,
      sealed: true,
      eligible: true,
      fixtureOnly: true,
      verdict: "directly_supported",
      claimRowId: null,
    })),
    whatChanged: [],
    rules: NO_RULES,
    ...overrides,
  };
}
