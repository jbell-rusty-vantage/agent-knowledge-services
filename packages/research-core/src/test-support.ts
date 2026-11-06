import {
  type EvaluatorIdentity,
  type Origin,
  type Ref,
  type RefKind,
  digestCanonical,
} from "@aiengineer/knowledge-operation-protocol";
import { recordRef } from "./digest.js";
import { ENGINEERING_RUBRIC_VERSION, type EngineeringQualifiers } from "./profiles/index.js";
import { ASSERTION_SCHEMA_VERSION, type AssertionVersion, qualifiersDigest } from "./records/assertion.js";
import {
  OBSERVATION_SCHEMA_VERSION,
  type SupportVerdict,
  type VerificationObservation,
} from "./records/observation.js";
import { SUPPORT_SET_SCHEMA_VERSION, type SupportSet } from "./records/support.js";

/** Deterministic fixtures for this package's tests. Not exported from the package index. */
export const TENANT = "tenant-a";
export const BINDING = "aiengineer-postgres";
export const SCOPE = { tenant: TENANT, binding: BINDING } as const;
export const AT = "2026-10-24T20:00:00Z";

export function ref<K extends RefKind>(kind: K, id: string, overrides: Partial<Ref<K>> = {}): Ref<K> {
  return {
    kind,
    id,
    version: kind === "rubric" ? ENGINEERING_RUBRIC_VERSION : "fixture.record.v1",
    digest: digestCanonical({ kind, id }),
    tenant: TENANT,
    binding: BINDING,
    ...overrides,
  } as Ref<K>;
}

export function origin(): Origin {
  return {
    kind: "standalone",
    installationId: "install-1",
    applicationId: "ai-engineer",
    tenantId: TENANT,
    issuer: "knowledge-services",
    subject: "producer-agent",
    mission: null,
    recoveryAuthorityRef: null,
    invocationId: "inv-1",
    authenticatedAt: AT,
  };
}

export function evaluator(role: EvaluatorIdentity["role"]): EvaluatorIdentity {
  return {
    role,
    kind: "model",
    provider: "provider-a",
    family: "family-a",
    model: "model-a",
    deployment: null,
    reviewerId: null,
    methodVersion: "l1-support.v2",
    promptDigest: null,
    configDigest: digestCanonical({ role }),
  };
}

export function qualifiers(overrides: Partial<EngineeringQualifiers> = {}): EngineeringQualifiers {
  return {
    profile: "engineering.v2",
    entity: "vLLM",
    population: null,
    time: { from: null, to: null, asOf: "2026-10-01T00:00:00Z" },
    unit: "tokens/s",
    jurisdiction: null,
    baseline: null,
    negation: false,
    modality: "asserted",
    comparison: null,
    runtime: "cuda-12",
    softwareVersion: "0.6.0",
    configuration: null,
    benchmarkEnvironment: null,
    denominator: null,
    repositoryCommit: null,
    ...overrides,
  };
}

export function assertion(id: string, overrides: Partial<AssertionVersion> = {}): AssertionVersion {
  return {
    schemaVersion: ASSERTION_SCHEMA_VERSION,
    id,
    tenant: TENANT,
    binding: BINDING,
    logicalId: `logical-${id}`,
    proposition: `Proposition ${id}`,
    kind: "world_fact",
    value: { type: "quantity", amount: "1200", unit: "tokens/s" },
    subject: null,
    object: null,
    qualifiers: qualifiers(),
    riskReasons: [],
    producer: origin(),
    premises: [],
    ...overrides,
  };
}

export function supportSet(
  id: string,
  target: AssertionVersion,
  premises: { premise: string; evidence?: Ref<"fragment">[]; derivedFrom?: Ref<"assertion">[] }[],
  overrides: Partial<SupportSet> = {},
): SupportSet {
  return {
    schemaVersion: SUPPORT_SET_SCHEMA_VERSION,
    id,
    tenant: TENANT,
    binding: BINDING,
    assertion: recordRef("assertion", target),
    qualifiersDigest: qualifiersDigest(target.qualifiers),
    provenance: "declared_citation",
    required: premises.map((premise) => ({
      premise: premise.premise,
      evidence: premise.evidence ?? [],
      derivedFrom: premise.derivedFrom ?? [],
    })),
    contrary: [],
    ...overrides,
  };
}

export function supportObservation(input: {
  id: string;
  set: SupportSet;
  target: AssertionVersion;
  verdict: SupportVerdict;
  premise?: string | null;
  role?: EvaluatorIdentity["role"];
  qualifiersOverride?: string;
  contradicting?: Ref<"fragment">[];
}): VerificationObservation {
  const cited =
    input.verdict === "full_support" || input.verdict === "qualified_support" ? [ref("fragment", "f-1")] : [];
  return {
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    id: input.id,
    tenant: TENANT,
    binding: BINDING,
    target: recordRef("support_set", input.set),
    inputDigest: digestCanonical({ input: input.id }),
    qualifiersDigest: (input.qualifiersOverride ?? qualifiersDigest(input.target.qualifiers)) as `sha256:${string}`,
    method: ref("method", "l1-support"),
    evaluator: evaluator(input.role ?? "judge"),
    rationale: "fixture rationale",
    limitations: [],
    evidence: cited,
    rawResponse: null,
    usage: { providerCalls: 1, tokens: 100, costUsd: "0.001" },
    recordedAt: AT,
    property: "support",
    outcome: {
      verdict: input.verdict,
      premise: input.premise ?? null,
      citedFragments: cited,
      contradictingFragments: input.contradicting ?? [],
      unsupportedFacets: [],
      qualification: input.verdict === "qualified_support" ? "only on cuda-12" : null,
    },
  };
}

/** An L0 integrity observation (deterministic mechanics) on a support set or assertion. */
export function integrityObservation(input: {
  id: string;
  target: Ref<"support_set"> | Ref<"assertion"> | Ref<"report">;
  evidence?: Ref<"fragment">[];
  result?: "pass" | "fail";
  role?: EvaluatorIdentity["role"];
}): VerificationObservation {
  return {
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    id: input.id,
    tenant: TENANT,
    binding: BINDING,
    target: input.target,
    inputDigest: digestCanonical({ integrity: input.id }),
    qualifiersDigest: null,
    method: ref("method", "l0-integrity"),
    evaluator: { ...evaluator(input.role ?? "producer"), kind: "deterministic" },
    rationale: "fixture integrity check",
    limitations: [],
    evidence: input.evidence ?? [],
    rawResponse: null,
    usage: { providerCalls: 0, tokens: 0, costUsd: "0" },
    recordedAt: AT,
    property: "integrity",
    outcome:
      (input.result ?? "fail") === "fail"
        ? { result: "fail", failureCodes: ["capture_digest_mismatch"] }
        : { result: "pass" },
  };
}

/** An authority observation (design §3.1 judgment 2) on a support set or assertion; non-adverse by default. */
export function authorityObservation(input: {
  id: string;
  target: Ref<"support_set"> | Ref<"assertion">;
  fragments?: Ref<"fragment">[];
  role?: EvaluatorIdentity["role"];
  fitness?: "fit" | "fit_with_limitations" | "unfit" | "unknown";
  applicability?: "applicable" | "partially_applicable" | "not_applicable" | "unknown";
  revision?: "current" | "corrected" | "retracted" | "withdrawn" | "unknown";
  qualifiersDigest?: `sha256:${string}` | null;
}): VerificationObservation {
  const fragments = input.fragments ?? [ref("fragment", "f-1")];
  return {
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    id: input.id,
    tenant: TENANT,
    binding: BINDING,
    target: input.target,
    inputDigest: digestCanonical({ authority: input.id }),
    qualifiersDigest: input.qualifiersDigest ?? null,
    method: ref("method", "source-authority"),
    evaluator: evaluator(input.role ?? "auditor"),
    rationale: "fixture authority judgment",
    limitations: [],
    evidence: fragments,
    rawResponse: null,
    usage: { providerCalls: 0, tokens: 0, costUsd: "0" },
    recordedAt: AT,
    property: "authority",
    outcome: {
      originFamilies: [{ family: "study-1", proposed: ["study-1"], fragments }],
      distinctOrigins: 1,
      unknownOriginFrontier: [],
      applicability: input.applicability ?? "applicable",
      directness: "direct",
      freshness: "current",
      fitness: input.fitness ?? "fit",
      fitnessRule: "fixture-rule",
      rules: { id: "fixture", version: "1.0.0", digest: digestCanonical({ rules: "fixture" }) },
      revisionFrontier: {
        status: input.revision ?? "current",
        checkedAt: AT,
        notices: [],
        checked: [{ identifier: "10.1000/fixture", status: input.revision ?? "current", noticeIdentifiers: [] }],
        unchecked: [],
      },
    },
  };
}

/** A bounded counterevidence search (challenge) on an assertion; searched with no conflict by default. */
export function challengeObservation(input: {
  id: string;
  target: AssertionVersion;
  role?: EvaluatorIdentity["role"];
  status?: "searched" | "not_searched";
  counterevidence?: Ref<"fragment">[];
  materialConflict?: boolean;
}): VerificationObservation {
  return {
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    id: input.id,
    tenant: TENANT,
    binding: BINDING,
    target: recordRef("assertion", input.target),
    inputDigest: digestCanonical({ challenge: input.id }),
    qualifiersDigest: qualifiersDigest(input.target.qualifiers),
    method: ref("method", "bounded-challenge"),
    evaluator: evaluator(input.role ?? "auditor"),
    rationale: "fixture challenge",
    limitations: [],
    evidence: input.counterevidence ?? [],
    rawResponse: null,
    usage: { providerCalls: 0, tokens: 0, costUsd: "0" },
    recordedAt: AT,
    property: "challenge",
    outcome:
      (input.status ?? "searched") === "not_searched"
        ? { status: "not_searched", reason: "budget exhausted" }
        : {
            status: "searched",
            queries: ["counterevidence for fixture"],
            counterevidence: input.counterevidence ?? [],
            materialConflict: input.materialConflict ?? false,
            frontier: {
              exhausted: true,
              searchedScopes: ["fixture-index"],
              limits: ["3 queries"],
              unsearchedScopes: [],
            },
          },
  };
}
