import { ResearchCoordinatorError, ReviewServiceError } from "@aiengineer/knowledge-application";
import {
  type CredentialClaims,
  DECISION_RESULT_VERSION,
  type Digest,
  type DecisionResolution,
  DecisionResolutionSchema,
  type DecisionResolveRequest,
  EVALUATION_CONTEXT_VERSION,
  type EvaluationContextRequest,
  EvaluationContextSchema,
  type JsonValue,
  digestBytes as canonicalDigestBytes,
  digestCanonical,
  EvaluatorIdentitySchema,
  type JsonDocument,
  OBSERVATION_RESULT_VERSION,
  OBSERVER_ROLES,
  type Origin,
  type ProtocolErrorCode,
  REVIEW_RESULT_VERSION,
  type Ref,
  type ReportObservationRequest,
  type ReportReviewRequest,
  type ReportSealRequest,
  type ReportUseRequest,
  SEAL_RESULT_VERSION,
  refOf,
  sameRef,
} from "@aiengineer/knowledge-operation-protocol";
import {
  type AuthScope,
  CensusExplanationSchema,
  type NormalizedValues,
  DiscoveredOccurrenceSchema,
  REVIEW_CONDITION,
  UnitExplanationSchema,
  UsageSchema,
  type VerificationObservation,
  VerificationObservationSchema,
  StructuredBodySchema,
  qualifiersDigest,
  recordRef,
  renderReport,
} from "@aiengineer/knowledge-research-core";
import { z } from "zod";
import { type Correlation, refusal } from "./errors.js";
import type { ResearchServices } from "./ports.js";

/**
 * Trusted assessment transport over the research services (Sprint OC WI-03, OUTPUT-CONTRACTS §5): observe -> seal ->
 * decideUse -> review -> resolve. Every function here takes the AUTHENTICATED claims; no role, reviewer or origin is
 * read from a payload. Each returns the custody result document and the run it touched; the service records the
 * durable operation (idempotent by request id) around it.
 *
 * Refusals are typed K01 errors whose `details.reason` names the cause (`AssessmentRefusalReason`).
 */
export type AssessmentRefusalReason =
  | "evaluator_role_required"
  | "evaluator_identity_conflict"
  | "evaluator_is_producer"
  | "census_requires_auditor"
  | "census_requires_discovery"
  | "observation_invalid"
  | "observation_conflict"
  | "evaluator_role_observed"
  | "target_unknown"
  | "handle_out_of_scope"
  | "revision_unavailable"
  | "run_sealed"
  | "run_not_sealed"
  | "decision_unknown"
  | "decision_superseded"
  | "review_binding_mismatch"
  | "reviewer_not_qualified"
  | "reviewer_is_producer"
  | "seal_key_unconfigured";

export interface AssessmentResult {
  readonly document: JsonDocument;
  readonly runId: string;
  readonly subject: Ref;
}

const fail = (code: ProtocolErrorCode, reason: AssessmentRefusalReason, message: string, correlation: Correlation) =>
  refusal(code, message, correlation, { reason });

/** The auditor's independent discovery pass, submitted by the MC-hosted auditor (the coordinator reconciles it). */
export const SubmittedCensusSchema = z.strictObject({
  evaluator: EvaluatorIdentitySchema,
  method: refOf("method"),
  occurrences: z.array(DiscoveredOccurrenceSchema).max(2048),
  explanations: z.array(CensusExplanationSchema).max(2048),
  unitExplanations: z.array(UnitExplanationSchema).max(2048),
  recall: z.discriminatedUnion("label", [
    z.strictObject({
      label: z.literal("measured"),
      numerator: z.number().int().min(0),
      denominator: z.number().int().min(1),
      calibration: refOf("artifact"),
    }),
    z.strictObject({ label: z.literal("unmeasured"), reason: z.string().min(1).max(500) }),
  ]),
  rationale: z.string().min(1).max(4000),
  limitations: z.array(z.string().min(1).max(500)).max(64),
  usage: UsageSchema,
  rawResponse: refOf("artifact").nullable(),
});

function inScope(scope: AuthScope, refs: readonly Ref[], correlation: Correlation): void {
  const foreign = refs.find((ref) => ref.tenant !== scope.tenant || ref.binding !== scope.binding);
  if (foreign !== undefined) {
    throw fail(
      "SCOPE_DENIED",
      "handle_out_of_scope",
      `${foreign.kind} ${foreign.id} is outside this scope`,
      correlation,
    );
  }
}

/** Producer identities of a run: the originating origin and every assertion's producer origin. */
function producers(origin: Origin, assertions: readonly { readonly producer: Origin }[]): Origin[] {
  return [origin, ...assertions.map((assertion) => assertion.producer)];
}

/**
 * The evaluator is independent of the producer: another authenticated subject, and (for mission work) another
 * operation. A producer credential presenting an evaluator grant still names the producer's subject and refuses.
 */
function assertIndependent(
  caller: Origin,
  producerOrigins: readonly Origin[],
  reason: "evaluator_is_producer" | "reviewer_is_producer",
  correlation: Correlation,
): void {
  const same = producerOrigins.some(
    (producer) =>
      producer.subject === caller.subject ||
      (producer.mission !== null &&
        caller.mission !== null &&
        producer.mission.missionId === caller.mission.missionId &&
        producer.mission.operationId === caller.mission.operationId),
  );
  if (same) {
    throw fail("INDEPENDENCE_UNPROVEN", reason, "the evaluator is the producer of the evaluated work", correlation);
  }
}

async function exactRun(scope: AuthScope, research: ResearchServices, report: Ref<"report">, correlation: Correlation) {
  inScope(scope, [report], correlation);
  const runId = await research.locator.runOf(scope, report);
  if (runId === null) {
    throw fail(
      "EXACT_REVISION_UNAVAILABLE",
      "revision_unavailable",
      "the exact report revision is unknown",
      correlation,
    );
  }
  const context = await research.binding.loadRunContext(scope, runId);
  if (context.report === null || !sameRef(recordRef("report", context.report.revision), report)) {
    throw fail("EXACT_REVISION_UNAVAILABLE", "revision_unavailable", "the run holds another revision", correlation);
  }
  return { runId, context };
}

export async function observeReport(
  claims: CredentialClaims,
  scope: AuthScope,
  research: ResearchServices,
  request: ReportObservationRequest,
  correlation: Correlation,
): Promise<AssessmentResult> {
  const evaluation = claims.evaluation;
  if (evaluation === undefined || !(OBSERVER_ROLES as readonly string[]).includes(evaluation.role)) {
    throw fail("ORIGIN_MISMATCH", "evaluator_role_required", "report.observe needs an observer grant", correlation);
  }
  const { runId, context } = await exactRun(scope, research, request.report, correlation);
  if (context.state === "sealed" || context.state === "superseded") {
    throw fail("EFFECT_CONFLICT", "run_sealed", "a sealed run takes no new observations", correlation);
  }
  assertIndependent(
    claims.origin,
    producers(context.originatingOrigin, context.assertions),
    "evaluator_is_producer",
    correlation,
  );
  // S5: a judge is always a model on the granted provider and family; only the auditor may also record a
  // deterministic observation (its census reconciliation). A human never observes here.
  const judgeRole = evaluation.role === "judge" || evaluation.role === "second_family_judge";
  const sameEvaluator = (evaluator: VerificationObservation["evaluator"]) => {
    if (evaluator.role !== evaluation.role) return false;
    if (evaluator.kind === "model") {
      return (
        evaluation.provider !== null &&
        evaluation.family !== null &&
        evaluator.provider === evaluation.provider &&
        evaluator.family === evaluation.family
      );
    }
    return !judgeRole && evaluator.kind === "deterministic";
  };
  const targets = new Set([
    ...context.assertions.map((assertion) => recordRef("assertion", assertion).digest),
    ...context.supportSets.map((set) => recordRef("support_set", set).digest),
    recordRef("report", context.report?.revision as never).digest,
  ]);
  const observations: VerificationObservation[] = [];
  for (const document of request.observations) {
    const parsed = VerificationObservationSchema.safeParse(document);
    if (!parsed.success) {
      throw refusal("INVALID_ENVELOPE", "an observation is not a valid VerificationObservation", correlation, {
        reason: "observation_invalid",
        issues: parsed.error.issues.slice(0, 20).map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`),
      });
    }
    const observation = parsed.data;
    if (observation.tenant !== scope.tenant || observation.binding !== scope.binding) {
      throw fail(
        "SCOPE_DENIED",
        "handle_out_of_scope",
        `observation ${observation.id} names another scope`,
        correlation,
      );
    }
    if (observation.property === "census") {
      throw fail("INVALID_ENVELOPE", "census_requires_discovery", "a census is submitted as a discovery", correlation);
    }
    if (!sameEvaluator(observation.evaluator)) {
      throw fail(
        "ORIGIN_MISMATCH",
        "evaluator_identity_conflict",
        `observation ${observation.id} names another evaluator than the credential grants`,
        correlation,
      );
    }
    if (!targets.has(observation.target.digest)) {
      throw fail(
        "NOT_FOUND",
        "target_unknown",
        `observation ${observation.id} targets nothing in this run`,
        correlation,
      );
    }
    observations.push(observation);
  }
  let census: z.infer<typeof SubmittedCensusSchema> | null = null;
  if (request.census !== null) {
    if (evaluation.role !== "auditor") {
      throw fail("ORIGIN_MISMATCH", "census_requires_auditor", "only an auditor submits the census", correlation);
    }
    const parsed = SubmittedCensusSchema.safeParse(request.census);
    if (!parsed.success) {
      throw refusal("INVALID_ENVELOPE", "the census is not a valid discovery", correlation, {
        reason: "observation_invalid",
        issues: parsed.error.issues.slice(0, 20).map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`),
      });
    }
    if (!sameEvaluator(parsed.data.evaluator)) {
      throw fail("ORIGIN_MISMATCH", "evaluator_identity_conflict", "the census names another evaluator", correlation);
    }
    census = parsed.data;
  }
  // N2 (no judge shopping): a role observes a run once. Its first observations stand (a failing or unsupported
  // verdict is sticky for this revision); only a reviewer decision moves the outcome. A replay of the same
  // observation ids passes through; any other observation from that role, or a second census, refuses.
  const requested = new Set(observations.map((observation) => observation.id));
  const recordedByRole = context.observations.filter((observation) => observation.evaluator.role === evaluation.role);
  const replay =
    census === null &&
    observations.length > 0 &&
    observations.every((observation) => context.observations.some((prior) => prior.id === observation.id));
  if (!replay && recordedByRole.some((prior) => !requested.has(prior.id))) {
    throw fail(
      "EFFECT_CONFLICT",
      "evaluator_role_observed",
      `the ${evaluation.role} already observed this run; its observations stand until a reviewer decides`,
      correlation,
    );
  }
  const refs: Ref<"observation">[] = [];
  for (const observation of observations) {
    const ref = recordRef("observation", observation);
    const prior = context.observations.find((candidate) => candidate.id === observation.id);
    if (prior !== undefined) {
      // A replay of the same observation is the same record; another body under its id conflicts.
      if (recordRef("observation", prior).digest !== ref.digest) {
        throw fail(
          "EFFECT_CONFLICT",
          "observation_conflict",
          `observation ${observation.id} already differs`,
          correlation,
        );
      }
      refs.push(ref);
      continue;
    }
    refs.push(await research.coordinator.observe(scope, runId, observation));
  }
  let censusResult: JsonDocument | null = null;
  if (census !== null) {
    const submitted = census;
    const audited = await research.coordinator.auditReport(scope, {
      runId,
      auditor: { discover: async () => submitted },
    });
    censusResult = {
      observation: audited.ref as unknown as JsonDocument,
      inventory: audited.inventory as unknown as JsonDocument,
      status: audited.census.status,
    };
  }
  return {
    runId,
    subject: request.report,
    document: {
      schema: OBSERVATION_RESULT_VERSION,
      report: request.report as unknown as JsonDocument,
      runId,
      role: evaluation.role,
      credentialRef: evaluation.credentialRef,
      observations: refs as unknown as JsonDocument,
      census: censusResult,
    },
  };
}

export async function sealReport(
  scope: AuthScope,
  research: ResearchServices,
  request: ReportSealRequest,
  signer: string,
  correlation: Correlation,
): Promise<AssessmentResult> {
  const { runId, context } = await exactRun(scope, research, request.report, correlation);
  let manifest: Ref;
  let run: Ref;
  if (context.head !== null && context.run !== null && context.manifests[0] !== undefined) {
    // Already sealed: the exact VerificationRun and verification manifest, unchanged (a retried seal is the seal).
    run = recordRef("verification_run", context.run);
    manifest = recordRef("run_manifest", context.manifests[0].manifest);
  } else {
    let sealed: Awaited<ReturnType<ResearchServices["coordinator"]["sealVerificationSnapshot"]>>;
    try {
      sealed = await research.coordinator.sealVerificationSnapshot(scope, { runId, build: request.build, signer });
    } catch (error) {
      if (error instanceof Error && /SEAL_KEY_UNCONFIGURED/.test(error.message)) {
        throw fail("CAPABILITY_UNAVAILABLE", "seal_key_unconfigured", "this executor has no run-seal key", correlation);
      }
      throw error;
    }
    run = sealed.run;
    manifest = recordRef("run_manifest", sealed.sealed.manifest);
  }
  const after = await research.binding.loadRunContext(scope, runId);
  return {
    runId,
    subject: request.report,
    document: {
      schema: SEAL_RESULT_VERSION,
      report: request.report as unknown as JsonDocument,
      runId,
      run: run as unknown as JsonDocument,
      manifest: manifest as unknown as JsonDocument,
      head: after.head,
      observations: after.observations.length,
    },
  };
}

export async function decideUse(
  scope: AuthScope,
  research: ResearchServices,
  request: ReportUseRequest,
  correlation: Correlation,
): Promise<AssessmentResult> {
  inScope(scope, [request.subject, request.policy, request.rubric], correlation);
  const { runId, context } = await exactRun(scope, research, request.report, correlation);
  if (context.head === null) {
    throw fail("EXACT_REVISION_UNAVAILABLE", "run_not_sealed", "a use decision follows the sealed run", correlation);
  }
  const base = {
    runId,
    use: request.use,
    audience: request.audience,
    boundEffectDigest: request.boundEffectDigest as Digest,
    targetSchema: request.targetSchema,
    // The protocol schema admits only strings, safe integers (zod `int`), booleans and null.
    normalizedValues: request.normalizedValues as NormalizedValues,
    policy: request.policy,
    rubric: request.rubric,
    expiresAt: request.expiresAt,
  };
  let decision: Awaited<ReturnType<ResearchServices["coordinator"]["decideReportUse"]>>["decision"];
  let ref: Ref<"use_decision">;
  let summary: JsonDocument;
  try {
    if (request.subject.kind === "report") {
      const decided = await research.coordinator.decideReportUse(scope, base);
      decision = decided.decision;
      ref = decided.ref;
      summary = {
        complete: decided.aggregate.complete,
        unmetRequired: [...decided.aggregate.unmetRequired],
        heldRequired: [...decided.aggregate.heldRequired],
        rejectingRequired: [...decided.aggregate.rejectingRequired],
        judgmentCovered: [...decided.aggregate.judgmentCovered],
        census: decided.census.status,
      };
    } else {
      const decided = await research.coordinator.decideAssertionUse(scope, {
        ...base,
        assertion: request.subject as Ref<"assertion">,
      });
      decision = decided.decision;
      ref = decided.ref;
      const evaluation = decided.evaluation;
      summary = evaluation.ok ? { passes: evaluation.passes, factEntailed: evaluation.factEntailed } : {};
    }
  } catch (error) {
    if (error instanceof ResearchCoordinatorError && error.code === "SUBJECT_NOT_IN_REPORT") {
      throw fail("NOT_FOUND", "target_unknown", error.message, correlation);
    }
    throw error;
  }
  return {
    runId,
    subject: request.subject,
    document: {
      schema: DECISION_RESULT_VERSION,
      purpose: request.purpose,
      decision: ref as unknown as JsonDocument,
      document: decision as unknown as JsonDocument,
      reviewPending: decision.disposition === "admitted" && decision.conditions.includes(REVIEW_CONDITION),
      summary,
    },
  };
}

export async function reviewDecision(
  claims: CredentialClaims,
  scope: AuthScope,
  research: ResearchServices,
  request: ReportReviewRequest,
  signer: string,
  correlation: Correlation,
): Promise<AssessmentResult> {
  if (claims.evaluation?.role !== "human_reviewer") {
    throw fail("ORIGIN_MISMATCH", "evaluator_role_required", "report.review needs a reviewer grant", correlation);
  }
  inScope(scope, [request.decision], correlation);
  const reviewer = claims.origin.subject;
  const stored = await research.binding.loadDecision(scope, request.decision.id);
  if (stored === null || !sameRef(recordRef("use_decision", stored.decision), request.decision)) {
    throw fail("NOT_FOUND", "decision_unknown", `no exact decision ${request.decision.id}`, correlation);
  }
  const context = await research.binding.loadRunContext(scope, stored.decision.run.id);
  assertIndependent(
    claims.origin,
    producers(context.originatingOrigin, context.assertions),
    "reviewer_is_producer",
    correlation,
  );
  if (stored.supersededBy !== null) {
    // A replay of this reviewer's own adjudication answers its successor; anyone else's review of it is stale.
    const successor = await research.binding.loadDecision(scope, stored.supersededBy);
    const adjudication =
      successor?.decision.reviewer === null || successor === null
        ? null
        : await research.binding.loadAdjudication(scope, successor.decision.reviewer.id);
    if (
      successor !== null &&
      adjudication !== null &&
      adjudication.reviewerId === reviewer &&
      adjudication.outcome === request.outcome &&
      adjudication.rationale === request.rationale
    ) {
      return reviewResult(stored.decision.run.id, request, successor.decision, recordRef("adjudication", adjudication));
    }
    throw fail("STALE_DECISION", "decision_superseded", `${request.decision.id} has a successor`, correlation);
  }
  try {
    const adjudicated = await research.review.adjudicate(scope, {
      decisionRef: request.decision,
      reviewer,
      outcome: request.outcome,
      boundEffectDigest: request.boundEffectDigest,
      qualifiersDigest: request.qualifiersDigest,
      rationale: request.rationale,
      signer,
    });
    return reviewResult(stored.decision.run.id, request, adjudicated.successor, adjudicated.adjudicationRef);
  } catch (error) {
    if (error instanceof ReviewServiceError) {
      if (error.code === "REVIEW_BINDING_MISMATCH") {
        throw fail("STALE_DECISION", "review_binding_mismatch", "the review signs other digests", correlation);
      }
      if (error.code === "STALE_DECISION") {
        throw fail("STALE_DECISION", "decision_superseded", error.message, correlation);
      }
      throw fail("NOT_FOUND", "decision_unknown", error.message, correlation);
    }
    if (error instanceof Error && /REVIEWER_NOT_QUALIFIED/.test(error.message)) {
      throw fail("SCOPE_DENIED", "reviewer_not_qualified", "no live reviewer grant covers this decision", correlation);
    }
    throw error;
  }
}

function reviewResult(
  runId: string,
  request: ReportReviewRequest,
  successor: { readonly id: string } & Record<string, unknown>,
  adjudication: Ref<"adjudication">,
): AssessmentResult {
  const successorRef = recordRef("use_decision", successor as never);
  return {
    runId,
    subject: request.decision,
    document: {
      schema: REVIEW_RESULT_VERSION,
      reviewed: request.decision as unknown as JsonDocument,
      adjudication: adjudication as unknown as JsonDocument,
      successor: successorRef as unknown as JsonDocument,
      document: successor as unknown as JsonDocument,
    },
  };
}

/** Lower-snake reason of an eligibility answer (`REVIEW_REQUIRED` -> `review_required`, `OK` -> null). */
function eligibilityReason(reason: string, status: string): string | null {
  if (status === "admitted") return null;
  const lowered = reason
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .slice(0, 64);
  return /^[a-z]/.test(lowered) ? lowered : "unknown";
}

export async function resolveDecision(
  scope: AuthScope,
  research: ResearchServices,
  request: DecisionResolveRequest,
  checkedAt: string,
  correlation: Correlation,
): Promise<AssessmentResult> {
  inScope(scope, [request.decision], correlation);
  const first = await research.binding.loadDecision(scope, request.decision.id);
  if (first === null || !sameRef(recordRef("use_decision", first.decision), request.decision)) {
    throw fail("NOT_FOUND", "decision_unknown", `no exact decision ${request.decision.id}`, correlation);
  }
  const chain = [first];
  for (let depth = 0; depth < 64; depth += 1) {
    const next = (chain[chain.length - 1] as (typeof chain)[number]).supersededBy;
    if (next === null) break;
    const successor = await research.binding.loadDecision(scope, next);
    if (successor === null) break;
    chain.push(successor);
  }
  const current = (chain[chain.length - 1] as (typeof chain)[number]).decision;
  const eligibility = await research.binding.checkUseEligibility(scope, {
    decisionId: current.id,
    boundEffectDigest: current.boundEffectDigest as Digest,
  });
  const reason = eligibilityReason(eligibility.reason, eligibility.outcome);
  const context = await research.binding.loadRunContext(scope, current.run.id);
  const { useClass } = research.coordinator.useClassFor(context.task, current.use, current.audience);
  const resolution: DecisionResolution = DecisionResolutionSchema.parse({
    schema: "use-decision-resolution.v1",
    requested: request.decision,
    current: recordRef("use_decision", current),
    runId: current.run.id,
    chain: chain.map((stored) => recordRef("use_decision", stored.decision)),
    report: current.report,
    subject: current.subject,
    use: current.use,
    audience: current.audience,
    useClass,
    disposition: current.disposition,
    conditions: current.conditions,
    admissibility: { status: eligibility.outcome, reason },
    reviewPending: current.disposition === "admitted" && eligibility.outcome === "held" && reason === "review_required",
    reviewer: current.reviewer,
    judgment: current.conditions
      .filter((condition) => condition.startsWith("judgment_not_entailed"))
      .map((condition) => condition.split(":")[1] ?? current.subject.id),
    revocationEpoch: current.revocationEpoch,
    checkedAt,
  });
  return {
    runId: current.run.id,
    subject: request.decision,
    document: resolution as unknown as JsonDocument,
  };
}

/**
 * `knowledge.read` with `evaluation-context-read/v1` (OVE-169): the exact evaluation context of one report revision for
 * the credential's observer role. Refuses a caller without an observer grant and the producer's own subject/operation;
 * re-verifies the frozen body and its structured source against the revision digests before anything is returned; the
 * judge gets the revision's support sets and their fragments, the auditor gets neither (RV-03), nobody the ledger.
 */
export async function evaluationContext(
  claims: CredentialClaims,
  scope: AuthScope,
  research: ResearchServices,
  request: EvaluationContextRequest,
  correlation: Correlation,
): Promise<AssessmentResult> {
  const evaluation = claims.evaluation;
  if (evaluation === undefined || !(OBSERVER_ROLES as readonly string[]).includes(evaluation.role)) {
    throw fail(
      "ORIGIN_MISMATCH",
      "evaluator_role_required",
      "the evaluation context needs an observer grant",
      correlation,
    );
  }
  const { runId, context } = await exactRun(scope, research, request.report, correlation);
  assertIndependent(
    claims.origin,
    producers(context.originatingOrigin, context.assertions),
    "evaluator_is_producer",
    correlation,
  );
  const revision = context.report?.revision;
  if (revision === undefined) {
    throw fail("EXACT_REVISION_UNAVAILABLE", "revision_unavailable", "the run holds no revision", correlation);
  }
  const custody = research.binding.custody;
  const bodyBytes = await custody.get(scope, revision.body);
  const structuredBytes = await custody.get(scope, revision.structuredBody);
  if (
    canonicalDigestBytes(bodyBytes) !== revision.bodyDigest ||
    revision.body.digest !== revision.bodyDigest ||
    canonicalDigestBytes(structuredBytes) !== revision.structuredBody.digest
  ) {
    throw fail(
      "EXACT_REVISION_UNAVAILABLE",
      "revision_unavailable",
      "stored body bytes differ from the revision",
      correlation,
    );
  }
  const frozen = renderReport(StructuredBodySchema.parse(JSON.parse(Buffer.from(structuredBytes).toString("utf8"))));
  if (frozen.bodyDigest !== revision.bodyDigest || frozen.renderer !== revision.renderer) {
    throw fail(
      "EXACT_REVISION_UNAVAILABLE",
      "revision_unavailable",
      "the structured body no longer renders to the revision",
      correlation,
    );
  }
  const members = context.assertions.filter((assertion) =>
    revision.assertions.some((handle) => sameRef(handle, recordRef("assertion", assertion))),
  );
  const judge = evaluation.role !== "auditor";
  const sets = judge
    ? context.supportSets.filter((set) =>
        members.some((assertion) => sameRef(set.assertion, recordRef("assertion", assertion))),
      )
    : null;
  let evidence: { handle: Ref; record: JsonDocument }[] | null = null;
  if (sets !== null) {
    const wanted = new Map<string, Ref<"fragment">>();
    for (const set of sets) {
      for (const ref of [...set.required.flatMap((premise) => premise.evidence), ...set.contrary])
        wanted.set(ref.id, ref);
    }
    const refs = [...wanted.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const fragments = refs.length === 0 ? [] : await research.binding.loadFragments(scope, refs);
    evidence = refs.map((ref) => {
      const record = fragments.find((fragment) => sameRef(recordRef("fragment", fragment), ref));
      if (record === undefined) {
        throw fail(
          "EXACT_REVISION_UNAVAILABLE",
          "revision_unavailable",
          `fragment ${ref.id} differs from its handle`,
          correlation,
        );
      }
      return { handle: ref, record: record as unknown as JsonDocument };
    });
  }
  const task = context.task;
  const document = EvaluationContextSchema.parse({
    schema: EVALUATION_CONTEXT_VERSION,
    report: request.report,
    revision: revision.id,
    kind: revision.kind,
    role: evaluation.role,
    request: digestCanonical(request as unknown as JsonValue),
    task: {
      handle: recordRef("task", task),
      use: task.use,
      audience: task.audience,
      policy: task.policy,
      rubric: task.rubric,
      minimumRisk: task.minimumRisk,
    },
    body: {
      artifact: revision.body,
      digest: revision.bodyDigest,
      bytes: bodyBytes.byteLength,
      renderer: revision.renderer,
      text: frozen.text,
    },
    units: frozen.units.map((unit) => ({
      path: unit.path,
      kind: unit.kind,
      span: unit.span === null ? null : { start: unit.span.start, end: unit.span.end },
      factual: unit.factual,
      excludedReason: unit.excludedReason,
    })),
    assertions: members.map((assertion) => ({
      handle: recordRef("assertion", assertion),
      record: assertion,
      qualifiersDigest: qualifiersDigest(assertion.qualifiers),
    })),
    supportSets: sets === null ? null : sets.map((set) => ({ handle: recordRef("support_set", set), record: set })),
    evidence,
  });
  return { runId, subject: request.report, document: document as unknown as JsonDocument };
}
