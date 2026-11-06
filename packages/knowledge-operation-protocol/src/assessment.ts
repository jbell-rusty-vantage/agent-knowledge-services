import { z } from "zod";
import { type JsonValue, digestCanonical } from "./canonical.js";
import {
  DigestSchema,
  IdSchema,
  InstantSchema,
  JsonDocumentSchema,
  JsonPrimitiveSchema,
  NameSchema,
  SafeIntSchema,
  SchemaVersionSchema,
  refOf,
  refOfAny,
} from "./primitives.js";

/**
 * Trusted report assessment and use review (Sprint OC WI-03 / OVE-165; Mission Control OUTPUT-CONTRACTS §5).
 *
 * Five handle operations compose the existing research services behind the authenticated K01 transport:
 *
 *  - `report.observe`   an independent evaluator (judge, second-family judge or auditor) appends its observations of
 *                       one exact registered revision; its role is the credential's `evaluation` grant, never a field
 *                       of the payload, and a producer credential cannot present one;
 *  - `report.seal`      the host seals the run's verification snapshot (one head; the exact VerificationRun + manifest);
 *  - `report.decide`    the host asks for an exact use decision of the sealed revision (or one of its assertions) for a
 *                       declared use, audience and purpose;
 *  - `report.review`    a reviewer adjudicates one exact current decision under a live grant; the reviewer is the
 *                       credential subject; a successor decision is persisted;
 *  - `decision.resolve` anyone with the grant resolves a decision to its current successor and its current exact-use
 *                       admissibility (epoch, review, expiry) after a restart.
 *
 * Every request is inline (native contract `<name>/v1`) and idempotent by request id: the same request id with other
 * bytes refuses `EFFECT_CONFLICT`; the result is a custody document named by the terminal handle's `resultRef`.
 */
export const OBSERVE_CONTRACT = { name: "report-observation", version: "v1" } as const;
export const SEAL_CONTRACT = { name: "report-seal", version: "v1" } as const;
export const DECIDE_CONTRACT = { name: "report-use", version: "v1" } as const;
export const REVIEW_CONTRACT = { name: "report-review", version: "v1" } as const;
export const RESOLVE_CONTRACT = { name: "decision-resolve", version: "v1" } as const;

export const OBSERVATION_RESULT_VERSION = "report-observation-result.v1" as const;
export const SEAL_RESULT_VERSION = "report-seal-result.v1" as const;
export const DECISION_RESULT_VERSION = "use-decision-result.v1" as const;
export const REVIEW_RESULT_VERSION = "report-review-result.v1" as const;
export const RESOLUTION_VERSION = "use-decision-resolution.v1" as const;

/** At most this many observations in one `report.observe` request. */
export const MAX_OBSERVATIONS = 64;

/** Evaluator roles a credential can grant for `report.observe` (the producer is never one). */
export const OBSERVER_ROLES = ["judge", "second_family_judge", "auditor"] as const;
/** Every role a credential's `evaluation` grant may name; `human_reviewer` is the only role `report.review` accepts. */
export const GRANTED_EVALUATOR_ROLES = [...OBSERVER_ROLES, "human_reviewer"] as const;

/**
 * The evaluator authority the issuing host attests for this invocation (a K07 claim, `evaluation`). The host binds it
 * from the evaluator invocation it admitted (Mission Control: the separate judge/auditor operation and its own
 * credential reference), never from the evaluated output.
 */
export const CredentialEvaluationSchema = z.strictObject({
  role: z.enum(GRANTED_EVALUATOR_ROLES),
  /** The evaluator's own admitted credential reference (a name, never secret bytes); distinct from the producer's. */
  credentialRef: IdSchema,
  /** Model provider/family the evaluator runs on (`null` for a human reviewer). Observations must agree with them. */
  provider: NameSchema.nullable(),
  family: NameSchema.nullable(),
});
export type CredentialEvaluation = z.infer<typeof CredentialEvaluationSchema>;

/**
 * `report-observation.v1`: observations of one exact revision. `observations` are `VerificationObservation` records
 * (research-core, validated by the binding); `census` is an auditor's independent discovery pass (occurrences,
 * explanations, unit explanations, recall, method, rationale, limitations, usage, raw response) which the coordinator
 * reconciles into ONE `auditor` census observation. A census needs the `auditor` role.
 */
export const ReportObservationRequestSchema = z
  .strictObject({
    schema: z.literal("report-observation.v1"),
    report: refOf("report"),
    observations: z.array(JsonDocumentSchema).max(MAX_OBSERVATIONS),
    census: JsonDocumentSchema.nullable(),
  })
  .refine((request) => request.observations.length > 0 || request.census !== null, {
    path: ["observations"],
    message: "an observation request carries at least one observation or a census",
  });
export type ReportObservationRequest = z.infer<typeof ReportObservationRequestSchema>;

/** `report-seal.v1`: seal the verification snapshot of the run that holds this exact revision. */
export const ReportSealRequestSchema = z.strictObject({
  schema: z.literal("report-seal.v1"),
  report: refOf("report"),
  build: z.strictObject({ buildId: IdSchema, runtime: NameSchema, dirty: z.boolean() }),
});
export type ReportSealRequest = z.infer<typeof ReportSealRequestSchema>;

/**
 * Why the decision is requested. `official` asks for current exact-use eligibility; `review_repair` asks for the held
 * decision and its findings for an authorized review or repair. The purpose is recorded with the decision request; it
 * never changes the disposition (a held decision stays held for every purpose).
 */
export const USE_PURPOSES = ["official", "review_repair"] as const;
export const UsePurposeSchema = z.enum(USE_PURPOSES);
export type UsePurpose = z.infer<typeof UsePurposeSchema>;

/** `report-use.v1`: an exact use decision of the sealed revision (`subject` is the report or one of its assertions). */
export const ReportUseRequestSchema = z
  .strictObject({
    schema: z.literal("report-use.v1"),
    report: refOf("report"),
    subject: refOfAny(["report", "assertion"]),
    use: NameSchema,
    audience: NameSchema,
    purpose: UsePurposeSchema,
    boundEffectDigest: DigestSchema,
    targetSchema: SchemaVersionSchema,
    normalizedValues: z.record(NameSchema, JsonPrimitiveSchema),
    policy: refOf("policy"),
    rubric: refOf("rubric"),
    expiresAt: InstantSchema.nullable(),
  })
  .refine(
    (request) =>
      request.subject.kind !== "report" ||
      (request.subject.id === request.report.id && request.subject.digest === request.report.digest),
    { path: ["subject"], message: "a report decision's subject is its report" },
  );
export type ReportUseRequest = z.infer<typeof ReportUseRequestSchema>;

/** `report-review.v1`: the reviewer (credential subject) adjudicates one exact current decision. */
export const ReportReviewRequestSchema = z.strictObject({
  schema: z.literal("report-review.v1"),
  decision: refOf("use_decision"),
  outcome: z.enum(["approve", "hold", "reject"]),
  /** The reviewer signs the decision's exact bound effect and qualifiers digests. */
  boundEffectDigest: DigestSchema,
  qualifiersDigest: DigestSchema.nullable(),
  rationale: z.string().min(1).max(4000),
});
export type ReportReviewRequest = z.infer<typeof ReportReviewRequestSchema>;

/** `decision-resolve.v1`: the current successor of an exact decision and its admissibility now. */
export const DecisionResolveRequestSchema = z.strictObject({
  schema: z.literal("decision-resolve.v1"),
  decision: refOf("use_decision"),
});
export type DecisionResolveRequest = z.infer<typeof DecisionResolveRequestSchema>;

export const ADMISSIBILITY_STATUSES = ["admitted", "held", "rejected"] as const;

/**
 * `use-decision-resolution.v1`: what `decision.resolve` answers. `chain` is the successor chain from the requested
 * decision to `current` (inclusive, oldest first). `admissibility` is the current exact-use check of `current` against
 * the authoritative revocation epoch, its review binding (live grant) and expiry; `reviewPending` says a qualified
 * review is the only missing condition. `judgment` lists the obligations or assertions covered only by policy-admitted
 * judgments: approval of those is never fact entailment.
 */
export const DecisionResolutionSchema = z.strictObject({
  schema: z.literal(RESOLUTION_VERSION),
  requested: refOf("use_decision"),
  current: refOf("use_decision"),
  /** Authoritative verification run of the stored current decision; never inferred from its opaque id. */
  runId: IdSchema.optional(),
  chain: z.array(refOf("use_decision")).min(1),
  report: refOf("report"),
  subject: refOfAny(["report", "assertion"]),
  use: NameSchema,
  audience: NameSchema,
  /** The K08 use class KS decided this (use, audience) under: consumers apply their own minimums per class. */
  useClass: z.enum(["official", "consequential", "internal", "draft"]),
  disposition: z.enum(ADMISSIBILITY_STATUSES),
  conditions: z.array(z.string().min(1).max(500)),
  admissibility: z.strictObject({
    status: z.enum(ADMISSIBILITY_STATUSES),
    reason: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,63}$/)
      .nullable(),
  }),
  reviewPending: z.boolean(),
  reviewer: refOf("adjudication").nullable(),
  judgment: z.array(IdSchema),
  revocationEpoch: SafeIntSchema,
  checkedAt: InstantSchema,
});
export type DecisionResolution = z.infer<typeof DecisionResolutionSchema>;

/** The digest of an assessment request's canonical bytes (what a durable wait record binds). */
export function assessmentRequestDigest(request: unknown): string {
  return digestCanonical(request as JsonValue);
}

/**
 * `evaluation-context-read/v1` (Sprint OC W1 / OVE-169): the exact context an INDEPENDENT evaluator reads for one
 * sealed-or-open report revision, served by `knowledge.read` under a credential carrying an observer `evaluation` grant
 * (never to the producer's subject or operation). The answer (`research-evaluation-context.v1`) binds the exact
 * revision and is digest-checked by KS before it is written; what it holds follows the granted role (RV-03 evaluator
 * isolation): every role gets the frozen body, its renderer units, the revision's assertions (with their qualifier
 * digests) and the task's use/policy/rubric; a judge also gets the revision's support sets and the evidence fragments
 * they name; an auditor gets neither (its census is an independent discovery). Nobody gets the producer ledger.
 */
export const EVALUATION_CONTEXT_CONTRACT = { name: "evaluation-context-read", version: "v1" } as const;
export const EVALUATION_CONTEXT_VERSION = "research-evaluation-context.v1" as const;

export const EvaluationContextRequestSchema = z.strictObject({
  schema: z.literal("evaluation-context-read.v1"),
  report: refOf("report"),
});
export type EvaluationContextRequest = z.infer<typeof EvaluationContextRequestSchema>;

const ContextMemberSchema = z.strictObject({ handle: z.unknown(), record: z.unknown() });
export const EvaluationContextSchema = z.strictObject({
  schema: z.literal(EVALUATION_CONTEXT_VERSION),
  report: refOf("report"),
  revision: IdSchema,
  kind: refOf("report_kind"),
  role: z.enum(OBSERVER_ROLES),
  request: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  task: z.strictObject({
    handle: refOf("task"),
    use: NameSchema,
    audience: NameSchema,
    policy: refOf("policy"),
    rubric: refOf("rubric"),
    minimumRisk: z.string().min(1),
  }),
  body: z.strictObject({
    artifact: refOf("artifact"),
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    bytes: SafeIntSchema,
    renderer: z.string().min(1),
    text: z.string(),
  }),
  units: z.array(
    z.strictObject({
      path: IdSchema,
      kind: z.string().min(1),
      span: z.strictObject({ start: SafeIntSchema, end: SafeIntSchema }).nullable(),
      factual: z.boolean(),
      excludedReason: z.string().nullable(),
    }),
  ),
  assertions: z.array(ContextMemberSchema.extend({ qualifiersDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/) })),
  supportSets: z.array(ContextMemberSchema).nullable(),
  evidence: z.array(ContextMemberSchema).nullable(),
});
export type EvaluationContext = z.infer<typeof EvaluationContextSchema>;
