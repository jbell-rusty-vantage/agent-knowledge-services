import { type Ref, digestBytes, sameRef } from "@aiengineer/knowledge-operation-protocol";
import {
  ADJUDICATION_SCHEMA_VERSION,
  type Adjudication,
  AdjudicationSchema,
  type AuthScope,
  type FamilyBinding,
  OBSERVATION_SCHEMA_VERSION,
  type ReviewerScope,
  ReviewerScopeSchema,
  USE_DECISION_SCHEMA_VERSION,
  type UseDecision,
  UseDecisionSchema,
  type VerificationObservation,
  VerificationObservationSchema,
  recordRef,
} from "@aiengineer/knowledge-research-core";
import type { Clock, ResearchCoordinator } from "./coordinator.js";
import { CORRECTION_RECHECK_SCHEMA_VERSION, type CorrectionRecheck, correctionRecheckBytes } from "./lineage.js";
import type { CorrectionClosure, CorrectionInput, ResearchBinding } from "./ports.js";

/**
 * Reviewer grant -> adjudication -> exact-use successor decision, and correction/revocation closure (design §7).
 *
 * A reviewer adjudicates ONE recorded use decision, signing its exact subject, bound effect digest and qualifiers
 * digest under a live grant whose scope covers the decision's use, audience and report kind (the store refuses
 * otherwise). The successor decision supersedes the reviewed one and names the adjudication: approval satisfies the
 * `review_required` condition only; the successor's disposition is re-derived from the sealed run's evidence, so
 * approval never waives mechanics. Each adjudication appends a signed `decision_snapshot` successor manifest.
 * Transport-free: the MC review handoff (SV-16) calls this service.
 */
export class ReviewServiceError extends Error {
  readonly code: "DECISION_NOT_FOUND" | "STALE_DECISION" | "REVIEW_BINDING_MISMATCH" | "REPORT_MISMATCH";
  constructor(code: ReviewServiceError["code"], message: string) {
    super(`${code}: ${message}`);
    this.name = "ReviewServiceError";
    this.code = code;
  }
}

export interface AdjudicateInput {
  readonly decisionRef: Ref<"use_decision">;
  readonly reviewer: string;
  readonly outcome: "approve" | "hold" | "reject";
  readonly boundEffectDigest: string;
  readonly qualifiersDigest: string | null;
  readonly rationale: string;
  /** Signer identity for the successor manifest. */
  readonly signer?: string;
}

export interface Adjudicated {
  readonly adjudication: Adjudication;
  readonly adjudicationRef: Ref<"adjudication">;
  readonly successor: UseDecision;
  readonly successorRef: Ref<"use_decision">;
}

export class ReviewService {
  constructor(
    private readonly binding: ResearchBinding,
    private readonly coordinator: ResearchCoordinator,
    private readonly clock: Clock,
  ) {}

  grantReviewer(
    scope: AuthScope,
    input: { reviewerId: string; scope: ReviewerScope; grantedBy: string },
  ): Promise<string> {
    return this.binding.grantReviewer(scope, {
      reviewerId: input.reviewerId,
      scope: ReviewerScopeSchema.parse(input.scope),
      grantedBy: input.grantedBy,
      grantedAt: this.clock.now(),
    });
  }

  revokeGrant(scope: AuthScope, grantId: string): Promise<void> {
    return this.binding.revokeReviewerGrant(scope, { grantId, at: this.clock.now() });
  }

  async adjudicate(scope: AuthScope, input: AdjudicateInput): Promise<Adjudicated> {
    const stored = await this.binding.loadDecision(scope, input.decisionRef.id);
    if (stored === null || !sameRef(recordRef("use_decision", stored.decision), input.decisionRef)) {
      throw new ReviewServiceError("DECISION_NOT_FOUND", `no exact decision ${input.decisionRef.id}`);
    }
    if (stored.supersededBy !== null) {
      throw new ReviewServiceError("STALE_DECISION", `${input.decisionRef.id} is superseded by ${stored.supersededBy}`);
    }
    const decision = stored.decision;
    if (
      decision.boundEffectDigest !== input.boundEffectDigest ||
      decision.qualifiersDigest !== input.qualifiersDigest
    ) {
      throw new ReviewServiceError("REVIEW_BINDING_MISMATCH", "the reviewer must sign the decision's exact digests");
    }
    const decidedAt = this.clock.now();
    const adjudication = AdjudicationSchema.parse({
      schemaVersion: ADJUDICATION_SCHEMA_VERSION,
      id: `adj-${digestBytes(`${decision.id}|${input.reviewer}|${input.outcome}|${decidedAt}`).slice(7, 31)}`,
      tenant: scope.tenant,
      binding: scope.binding,
      decision: input.decisionRef,
      subject: decision.subject,
      boundEffectDigest: decision.boundEffectDigest,
      qualifiersDigest: decision.qualifiersDigest,
      reviewerId: input.reviewer,
      outcome: input.outcome,
      rationale: input.rationale,
      decidedAt,
    } satisfies Adjudication);
    // The store refuses REVIEWER_NOT_QUALIFIED (no live grant covering the scope) before anything else is written.
    const adjudicationRef = await this.binding.recordAdjudication(scope, adjudication);
    const evidence = await this.coordinator.evaluateSubject(scope, decision);
    const disposition =
      input.outcome === "reject" ? "rejected" : input.outcome === "hold" ? "held" : evidence.disposition; // approval cannot waive mechanics
    const epoch = await this.binding.currentEpoch(scope);
    const successor = UseDecisionSchema.parse({
      ...decision,
      schemaVersion: USE_DECISION_SCHEMA_VERSION,
      id: `${decision.id.slice(0, 160)}-rv${adjudication.id.slice(4, 16)}`,
      disposition,
      conditions: [...new Set([...decision.conditions, ...evidence.conditions, `reviewed:${adjudication.id}`])],
      revocationEpoch: epoch,
      decidedAt,
      reviewer: adjudicationRef,
    } satisfies UseDecision);
    // Signed successor manifest (design §6): the review appends to the run lineage, never rewrites it.
    const families: FamilyBinding[] = [
      { family: "report", ref: decision.report },
      { family: "decisions", ref: recordRef("use_decision", successor) },
      { family: "adjudication", ref: adjudicationRef },
    ];
    const successorRef = await this.binding.recordDecision(scope, successor, { supersedes: decision.id });
    await this.coordinator.sealSuccessor(scope, {
      runId: decision.run.id,
      snapshot: "decision_snapshot",
      families,
      signer: input.signer ?? "ks-sealer",
    });
    return { adjudication, adjudicationRef, successor, successorRef };
  }
}

/**
 * Explicit source correction or revocation (design §7): record the invalidation and its closure (epoch advance;
 * dependent decisions lose current-use eligibility at once), then recheck the affected closure by APPENDING
 * observations: an L0 `source_corrected` integrity observation on every affected support set, appended to open runs
 * directly and to sealed runs as a signed `correction_snapshot` successor. Unrelated branches are untouched.
 */
export class CorrectionService {
  constructor(
    private readonly binding: ResearchBinding,
    private readonly coordinator: ResearchCoordinator,
    private readonly clock: Clock,
  ) {}

  async recordCorrection(
    scope: AuthScope,
    input: CorrectionInput & {
      readonly evaluator: VerificationObservation["evaluator"];
      readonly method: Ref<"method">;
      readonly signer?: string;
    },
  ): Promise<CorrectionClosure & { readonly rechecked: readonly Ref<"observation">[] }> {
    const closure = await this.binding.recordCorrection(scope, { corrected: input.corrected, reason: input.reason });
    const affectedSets = new Set(closure.affected.filter((item) => item.kind === "support_set").map((item) => item.id));
    const rechecked: Ref<"observation">[] = [];
    for (const run of closure.runs) {
      const context = await this.binding.loadRunContext(scope, run.runId);
      const observations = context.supportSets
        .filter((set) => affectedSets.has(set.id))
        .map((set) =>
          VerificationObservationSchema.parse({
            schemaVersion: OBSERVATION_SCHEMA_VERSION,
            id: `recheck-${closure.invalidationId.slice(0, 40)}-${set.id.slice(0, 100)}`,
            tenant: scope.tenant,
            binding: scope.binding,
            target: recordRef("support_set", set),
            inputDigest: digestBytes(`${closure.invalidationId}|${recordRef("support_set", set).digest}`),
            qualifiersDigest: null,
            method: input.method,
            evaluator: input.evaluator,
            rationale: `correction ${closure.invalidationId} of ${input.corrected.kind} ${input.corrected.id}: ${input.reason}`,
            limitations: [],
            evidence: [...closure.fragments],
            rawResponse: null,
            usage: { providerCalls: 0, tokens: 0, costUsd: "0" },
            recordedAt: this.clock.now(),
            property: "integrity",
            outcome: { result: "fail", failureCodes: ["source_corrected"] },
          } satisfies VerificationObservation),
        );
      if (observations.length === 0) continue;
      if (context.state === "sealed" || context.state === "superseded") {
        if (context.report === null) continue;
        const recheck: CorrectionRecheck = {
          schemaVersion: CORRECTION_RECHECK_SCHEMA_VERSION,
          invalidationId: closure.invalidationId,
          epoch: closure.epoch,
          corrected: input.corrected,
          reason: input.reason,
          observations,
        };
        const artifact = await this.binding.custody.put(
          scope,
          Buffer.from(correctionRecheckBytes(recheck), "utf8"),
          "application/json",
        );
        await this.coordinator.sealSuccessor(scope, {
          runId: run.runId,
          snapshot: "correction_snapshot",
          families: [
            { family: "report", ref: recordRef("report", context.report.revision) },
            { family: "observations", ref: artifact },
          ],
          signer: input.signer ?? "ks-sealer",
        });
      } else {
        for (const observation of observations) await this.binding.appendObservation(scope, run.runId, observation);
      }
      rechecked.push(...observations.map((observation) => recordRef("observation", observation)));
    }
    return { ...closure, rechecked };
  }
}
