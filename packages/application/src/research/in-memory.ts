import {
  type Digest,
  type JsonValue,
  OperationStatusSchema,
  type Origin,
  PROTOCOL_VERSION,
  type Ref,
  canTransition,
  digestBytes,
  isTerminal,
  transitionStatus,
} from "@aiengineer/knowledge-operation-protocol";
import {
  type Adjudication,
  AdjudicationSchema,
  type AssertionVersion,
  type AuthScope,
  type CustodyStore,
  type EvidenceFragment,
  type FamilyContent,
  type ReportLedger,
  type ReportRevision,
  type RunManifest,
  type Seal,
  type SealVerifier,
  SealedRunSchema,
  type SealedRun,
  type SupportSet,
  type UseDecision,
  type VerificationObservation,
  type VerificationRun,
  type VerificationTaskContract,
  admissible,
  manifestDigest,
  normalizedValuesDigest,
  recordRef,
  scopeCovers,
} from "@aiengineer/knowledge-research-core";
import { parseCorrectionRecheck, SealVerificationError, verifySealedLineage } from "./lineage.js";
import { SealKeyRegistryError } from "./signing.js";
import {
  type AdmissionOutcome,
  type CorrectionClosure,
  type CorrectionInput,
  type OperationRecord,
  type OperationStart,
  type OperationStore,
  OperationStoreError,
  type OperationTransition,
  type RecordCollision,
  type RecordProbe,
  type ReportAssessmentRecord,
  type ResearchBinding,
  type ReviewerGrantInput,
  type RunContext,
  type RunOpening,
  type StoredDecision,
} from "./ports.js";

/**
 * In-memory binding for T0 proofs of the coordinator. It mirrors the component's rules that matter to the
 * coordinator (one head, CAS seal with a verified Ed25519 signature, sealed runs refuse observations, epoch-checked
 * admission through research-core `admissible`, scoped reviewer grants, invalidation closure) without a database.
 * It is a test double, never deployment authority.
 */
class InMemoryCustody implements CustodyStore {
  readonly artifacts = new Map<string, { bytes: Uint8Array; mediaType: string; tenant: string }>();

  async put(scope: AuthScope, bytes: Uint8Array, mediaType: string): Promise<Ref<"artifact">> {
    const digest = digestBytes(bytes);
    const id = `artifact-${digest.slice(7, 31)}`;
    this.artifacts.set(`${scope.tenant}/${id}`, { bytes: new Uint8Array(bytes), mediaType, tenant: scope.tenant });
    return { kind: "artifact", id, version: "artifact.v1", digest, tenant: scope.tenant, binding: scope.binding };
  }

  async get(scope: AuthScope, artifact: Ref<"artifact">): Promise<Uint8Array> {
    const stored = this.artifacts.get(`${scope.tenant}/${artifact.id}`);
    if (!stored) throw new Error("ARTIFACT_NOT_FOUND");
    return stored.bytes;
  }

  async verify(scope: AuthScope, artifact: Ref<"artifact">): Promise<boolean> {
    const stored = this.artifacts.get(`${scope.tenant}/${artifact.id}`);
    return stored !== undefined && digestBytes(stored.bytes) === artifact.digest;
  }
}

interface MemoryRun {
  readonly task: VerificationTaskContract;
  readonly openedAt: string;
  readonly originatingOrigin: Origin;
  state: RunContext["state"];
  head: Digest | null;
  report: { revision: ReportRevision; ledger: ReportLedger } | null;
  run: VerificationRun | null;
  readonly observations: VerificationObservation[];
  readonly manifests: SealedRun[];
}

interface MemoryGrant extends ReviewerGrantInput {
  readonly grantId: string;
  revokedAt: string | null;
}

const ADMISSION_REASON: Record<string, string> = {
  decision_rejected: "DECISION_REJECTED",
  scope_mismatch: "SCOPE_MISMATCH",
  use_mismatch: "USE_MISMATCH",
  audience_mismatch: "AUDIENCE_MISMATCH",
  effect_digest_mismatch: "EFFECT_DIGEST_MISMATCH",
  normalized_values_mismatch: "NORMALIZED_VALUES_MISMATCH",
  invalidated: "DECISION_INVALIDATED",
  decision_held: "DECISION_HELD",
  authority_unavailable: "AUTHORITY_UNAVAILABLE",
  stale_epoch: "REVOCATION_EPOCH_STALE",
  decision_epoch_ahead_of_authority: "REVOCATION_EPOCH_STALE",
  invalidation_closure_incomplete: "INVALIDATION_CLOSURE_INCOMPLETE",
  review_required: "REVIEW_REQUIRED",
  expired: "DECISION_EXPIRED",
};

export interface InMemoryBindingOptions {
  /** K07 verifier with the pinned seal keys; sealing and loading a sealed run refuse without one. */
  readonly sealVerifier?: SealVerifier;
  /** The admission clock (`now` for expiry); defaults to the wall clock. */
  readonly now?: () => string;
}

export class InMemoryResearchBinding implements ResearchBinding {
  readonly binding: string;
  readonly custody = new InMemoryCustody();
  readonly tasks = new Map<string, VerificationTaskContract>();
  readonly runs = new Map<string, MemoryRun>();
  readonly fragments = new Map<string, EvidenceFragment>();
  readonly assertions = new Map<string, AssertionVersion>();
  readonly supportSets = new Map<string, SupportSet>();
  readonly decisions = new Map<string, UseDecision>();
  readonly supersedes = new Map<string, string>();
  readonly grants = new Map<string, MemoryGrant>();
  readonly adjudications = new Map<string, Adjudication & { grantId: string }>();
  readonly invalidated = new Set<string>();
  readonly operations = new InMemoryOperationStore();
  epoch = 0;
  closureComplete = true;
  private sequence = 0;
  private readonly sealVerifier: SealVerifier | null;
  private readonly now: () => string;

  constructor(binding = "in-memory", options: InMemoryBindingOptions = {}) {
    this.binding = binding;
    this.sealVerifier = options.sealVerifier ?? null;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async freezeTask(_scope: AuthScope, task: VerificationTaskContract): Promise<Ref<"task">> {
    const existing = this.tasks.get(task.id);
    if (existing !== undefined && recordRef("task", existing).digest !== recordRef("task", task).digest) {
      throw new Error(`TASK_CONFLICT: ${task.id} holds another record`);
    }
    this.tasks.set(task.id, task);
    return recordRef("task", task);
  }

  async openRun(_scope: AuthScope, opening: RunOpening): Promise<string> {
    const task = this.tasks.get(opening.task.id);
    if (!task) throw new Error("TASK_NOT_FOUND");
    const runId = `run-${++this.sequence}`;
    this.runs.set(runId, {
      task,
      openedAt: opening.openedAt,
      originatingOrigin: opening.originatingOrigin,
      state: "preparing",
      head: null,
      report: null,
      run: null,
      observations: [],
      manifests: [],
    });
    return runId;
  }

  async putFragment(_scope: AuthScope, fragment: EvidenceFragment): Promise<Ref<"fragment">> {
    // Identical re-registration is a no-op (same digest, same ref); other bytes under the same id conflict.
    const existing = this.fragments.get(fragment.id);
    if (existing !== undefined && recordRef("fragment", existing).digest !== recordRef("fragment", fragment).digest) {
      throw new Error(`FRAGMENT_CONFLICT: ${fragment.id} holds another record`);
    }
    this.fragments.set(fragment.id, fragment);
    return recordRef("fragment", fragment);
  }

  async loadFragments(_scope: AuthScope, refs: readonly Ref<"fragment">[]): Promise<readonly EvidenceFragment[]> {
    const digests = new Set(refs.map((ref) => ref.digest));
    return [...this.fragments.values()].filter((fragment) => digests.has(recordRef("fragment", fragment).digest));
  }

  async putAssertion(_scope: AuthScope, assertion: AssertionVersion): Promise<Ref<"assertion">> {
    const existing = this.assertions.get(assertion.id);
    if (
      existing !== undefined &&
      recordRef("assertion", existing).digest !== recordRef("assertion", assertion).digest
    ) {
      throw new Error(`ASSERTION_CONFLICT: ${assertion.id} holds another record`);
    }
    this.assertions.set(assertion.id, assertion);
    return recordRef("assertion", assertion);
  }

  async loadAssertions(_scope: AuthScope, refs: readonly Ref<"assertion">[]): Promise<readonly AssertionVersion[]> {
    const digests = new Set(refs.map((ref) => ref.digest));
    return [...this.assertions.values()].filter((assertion) => digests.has(recordRef("assertion", assertion).digest));
  }

  async recordCollisions(_scope: AuthScope, records: readonly RecordProbe[]): Promise<readonly RecordCollision[]> {
    const stores = {
      task: this.tasks,
      fragment: this.fragments,
      assertion: this.assertions,
      support_set: this.supportSets,
    } as const;
    const collisions: RecordCollision[] = [];
    for (const probe of records) {
      const held = [...(stores[probe.kind] as Map<string, { readonly id: string }>).values()];
      const digestOf = (record: { readonly id: string }) => recordRef(probe.kind, record as never).digest;
      const sameId = held.find((record) => record.id === probe.id);
      if (sameId !== undefined) {
        if (digestOf(sameId) !== probe.digest) {
          collisions.push({ reason: "record_id_conflict", record: probe.kind, id: probe.id });
        }
        continue;
      }
      const sameBytes = held.find((record) => digestOf(record) === probe.digest);
      if (sameBytes !== undefined) {
        collisions.push({ reason: "record_digest_exists", record: probe.kind, id: sameBytes.id });
      }
    }
    return collisions;
  }

  async putSupportSet(_scope: AuthScope, set: SupportSet): Promise<Ref<"support_set">> {
    const existing = this.supportSets.get(set.id);
    if (existing !== undefined && recordRef("support_set", existing).digest !== recordRef("support_set", set).digest) {
      throw new Error(`SUPPORT_SET_CONFLICT: ${set.id} holds another record`);
    }
    this.supportSets.set(set.id, set);
    return recordRef("support_set", set);
  }

  async putReportRevision(
    _scope: AuthScope,
    input: { runId: string; reportId: string; revision: number; record: ReportRevision; ledger: ReportLedger },
  ): Promise<Ref<"report">> {
    const run = this.require(input.runId);
    if (run.report !== null) throw new Error("REPORT_ALREADY_REGISTERED");
    run.report = { revision: input.record, ledger: input.ledger };
    run.state = "observing";
    return recordRef("report", input.record);
  }

  async appendObservation(
    _scope: AuthScope,
    runId: string,
    observation: VerificationObservation,
  ): Promise<Ref<"observation">> {
    const run = this.require(runId);
    if (run.state === "sealed" || run.state === "superseded") throw new Error("RUN_SEALED");
    run.observations.push(observation);
    return recordRef("observation", observation);
  }

  /** Every family a manifest may bind, re-read from custody and the stored records (never from the manifest). */
  private familyContents(scope: AuthScope, sealed: SealedRun, run: MemoryRun): FamilyContent[] {
    return sealed.manifest.families.flatMap((binding): FamilyContent[] => {
      const ref = binding.ref;
      if (ref.kind === "artifact") {
        const stored = this.custody.artifacts.get(`${scope.tenant}/${ref.id}`);
        return stored ? [{ family: binding.family, kind: "bytes", bytes: stored.bytes }] : [];
      }
      if (ref.kind === "report") {
        return run.report
          ? [{ family: binding.family, kind: "record", value: run.report.revision as unknown as JsonValue }]
          : [];
      }
      if (ref.kind === "use_decision") {
        const decision = this.decisions.get(ref.id);
        return decision ? [{ family: binding.family, kind: "record", value: decision as unknown as JsonValue }] : [];
      }
      if (ref.kind === "adjudication") {
        const stored = this.adjudications.get(ref.id);
        if (!stored) return [];
        const { grantId: _grant, ...adjudication } = stored;
        return [{ family: binding.family, kind: "record", value: adjudication as unknown as JsonValue }];
      }
      return [];
    });
  }

  async loadRunContext(scope: AuthScope, runId: string): Promise<RunContext> {
    const run = this.require(runId);
    if (run.manifests.length > 0) {
      if (this.sealVerifier === null) throw new SealVerificationError("SEAL_INVALID", "no seal verifier is configured");
      verifySealedLineage(run.manifests, this.sealVerifier, (sealed) => this.familyContents(scope, sealed, run));
    }
    const occurrences = run.report?.ledger.entries ?? [];
    const assertionIds = new Set(run.report?.revision.assertions.map((ref) => ref.id) ?? []);
    for (const occurrence of occurrences) assertionIds.add(occurrence.assertion.id);
    const assertions = [...this.assertions.values()].filter((assertion) => assertionIds.has(assertion.id));
    const assertionDigests = new Set(assertions.map((assertion) => recordRef("assertion", assertion).digest));
    const supportSets = [...this.supportSets.values()].filter((set) => assertionDigests.has(set.assertion.digest));
    // Correction snapshots append recheck observations to the sealed lineage (design §7); they count from then on.
    const rechecks = run.manifests
      .filter((sealed) => sealed.manifest.snapshot === "correction_snapshot")
      .flatMap((sealed) => {
        const family = sealed.manifest.families.find((binding) => binding.family === "observations");
        const stored = family ? this.custody.artifacts.get(`${scope.tenant}/${family.ref.id}`) : undefined;
        return stored ? parseCorrectionRecheck(stored.bytes).observations : [];
      });
    const mission = run.originatingOrigin.mission;
    return {
      runId,
      state: run.state,
      openedAt: run.openedAt,
      head: run.head,
      task: run.task,
      report: run.report,
      assertions,
      supportSets,
      occurrences,
      observations: [...run.observations, ...rechecks],
      originatingOrigin: run.originatingOrigin,
      missionCorrelation: mission ? { missionId: mission.missionId, runId: mission.runId } : null,
      operationId: mission?.operationId ?? `standalone:${runId}`,
      run: run.run,
      manifests: [...run.manifests],
    };
  }

  async seal(
    _scope: AuthScope,
    input: { runId: string; run: VerificationRun; manifest: RunManifest; seal: Seal; expectedHead: Digest | null },
  ): Promise<SealedRun> {
    // All checks before any write: the run record, manifest and head commit together or not at all.
    const run = this.require(input.runId);
    if (this.sealVerifier === null) throw new SealVerificationError("SEAL_INVALID", "no seal verifier is configured");
    if (run.head !== input.expectedHead)
      throw new Error(`HEAD_MISMATCH: expected ${input.expectedHead}, head ${run.head}`);
    if (
      run.run !== null &&
      recordRef("verification_run", run.run).digest !== recordRef("verification_run", input.run).digest
    ) {
      throw new Error("RUN_IDENTITY_IMMUTABLE");
    }
    if (input.manifest.run.id !== input.runId || input.run.id !== input.runId) throw new Error("RUN_LINK_MISMATCH");
    if ((input.manifest.predecessor?.digest ?? null) !== run.head) throw new Error("LINEAGE_MISMATCH");
    if (input.manifest.snapshot === "verification_snapshot" && run.head !== null) {
      throw new Error("VERIFICATION_SNAPSHOT_EXISTS");
    }
    const digest = manifestDigest(input.manifest);
    if (input.seal.manifestDigest !== digest) throw new Error("SEAL_DIGEST_MISMATCH");
    const verdict = this.sealVerifier.verify(input.seal, digest);
    // W1 D25: the pinned-key registry (here the verifier's pins) names an unknown or retired key, typed.
    if (!verdict.ok && verdict.reason === "unknown_key") {
      throw new SealKeyRegistryError("SEAL_KEY_UNREGISTERED", input.seal.keyId);
    }
    if (!verdict.ok && verdict.reason === "retired_key") {
      throw new SealKeyRegistryError("SEAL_KEY_INACTIVE", input.seal.keyId, "revoked");
    }
    if (!verdict.ok) throw new SealVerificationError("SEAL_INVALID", verdict.reason);
    const sealed = SealedRunSchema.parse({ manifest: input.manifest, seal: input.seal });
    run.run = input.run;
    run.manifests.push(sealed);
    run.head = digest;
    run.state = "sealed";
    return sealed;
  }

  async recordDecision(
    _scope: AuthScope,
    decision: UseDecision,
    options: { readonly supersedes?: string | null } = {},
  ): Promise<Ref<"use_decision">> {
    const run = this.require(decision.run.id);
    if (run.state !== "sealed") throw new Error("RUN_NOT_SEALED");
    if (this.decisions.has(decision.id)) throw new Error("IMMUTABLE_RECORD: use decision");
    if (decision.reviewer !== null) {
      const adjudication = this.adjudications.get(decision.reviewer.id);
      if (adjudication === undefined || adjudication.boundEffectDigest !== decision.boundEffectDigest) {
        throw new Error("REVIEW_BINDING_MISMATCH");
      }
      if (
        adjudication.subject.digest !== decision.subject.digest ||
        adjudication.qualifiersDigest !== decision.qualifiersDigest ||
        adjudication.decision.id !== (options.supersedes ?? null)
      ) {
        throw new Error("ADJUDICATION_SUBJECT_MISMATCH");
      }
      if (decision.disposition === "admitted" && adjudication.outcome !== "approve")
        throw new Error("REVIEW_NOT_APPROVED");
    }
    this.decisions.set(decision.id, decision);
    if (options.supersedes) this.supersedes.set(decision.id, options.supersedes);
    return recordRef("use_decision", decision);
  }

  async loadDecision(_scope: AuthScope, decisionId: string): Promise<StoredDecision | null> {
    const decision = this.decisions.get(decisionId);
    if (decision === undefined) return null;
    const supersededBy = [...this.supersedes.entries()].find(([, prior]) => prior === decisionId)?.[0] ?? null;
    return { decision, supersedes: this.supersedes.get(decisionId) ?? null, supersededBy };
  }

  private reportKindOf(decision: UseDecision): string {
    for (const run of this.runs.values()) {
      if (run.report?.revision.id === decision.report.id) return run.report.revision.kind.id.split("@")[0] ?? "";
    }
    return "";
  }

  private grantLive(grantId: string, decision: UseDecision, at: string): boolean {
    const grant = this.grants.get(grantId);
    return (
      grant !== undefined &&
      (grant.revokedAt === null || Date.parse(grant.revokedAt) > Date.parse(at)) &&
      scopeCovers(grant.scope, {
        use: decision.use,
        audience: decision.audience,
        reportKind: this.reportKindOf(decision),
      })
    );
  }

  /** The admission rule at the current epoch with the decision's own values digest; records nothing. */
  async checkUseEligibility(
    scope: AuthScope,
    input: { decisionId: string; boundEffectDigest: Digest },
  ): Promise<AdmissionOutcome> {
    const decision = this.decisions.get(input.decisionId);
    if (!decision) return { outcome: "rejected", reason: "DECISION_NOT_FOUND", authoritativeEpoch: this.epoch };
    return this.admitExactUse(scope, {
      decisionId: input.decisionId,
      boundEffectDigest: input.boundEffectDigest,
      processedEpoch: this.epoch,
      normalizedValuesDigest: normalizedValuesDigest(decision.normalizedValues),
    });
  }

  async admitExactUse(
    scope: AuthScope,
    input: { decisionId: string; boundEffectDigest: Digest; processedEpoch: number; normalizedValuesDigest: Digest },
  ): Promise<AdmissionOutcome> {
    const decision = this.decisions.get(input.decisionId);
    if (!decision) return { outcome: "rejected", reason: "DECISION_NOT_FOUND", authoritativeEpoch: this.epoch };
    if ([...this.supersedes.values()].includes(decision.id)) {
      return { outcome: "held", reason: "STALE_DECISION", authoritativeEpoch: this.epoch };
    }
    const now = this.now();
    const adjudication = decision.reviewer ? this.adjudications.get(decision.reviewer.id) : undefined;
    // One admission rule set: research-core `admissible` (the component applies the same rules in SQL).
    const verdict = admissible(decision, {
      tenant: scope.tenant,
      use: decision.use,
      audience: decision.audience,
      authoritativeEpoch: this.epoch,
      processedEpoch: input.processedEpoch,
      closureComplete: this.closureComplete,
      invalidated: this.invalidated,
      now,
      boundEffectDigest: input.boundEffectDigest,
      normalizedValuesDigest: input.normalizedValuesDigest,
      review: adjudication
        ? {
            adjudicationId: adjudication.id,
            outcome: adjudication.outcome,
            boundEffectDigest: adjudication.boundEffectDigest,
            qualifiersDigest: adjudication.qualifiersDigest,
            grantLive: this.grantLive(adjudication.grantId, decision, now),
          }
        : null,
    });
    if (verdict.status === "admitted") return { outcome: "admitted", reason: "OK", authoritativeEpoch: this.epoch };
    return {
      outcome: verdict.status,
      reason: ADMISSION_REASON[verdict.reason] ?? verdict.reason,
      authoritativeEpoch: this.epoch,
    };
  }

  async grantReviewer(_scope: AuthScope, grant: ReviewerGrantInput): Promise<string> {
    const grantId = `grant-${this.grants.size + 1}`;
    this.grants.set(grantId, { ...grant, grantId, revokedAt: null });
    return grantId;
  }

  async revokeReviewerGrant(_scope: AuthScope, input: { grantId: string; at: string }): Promise<void> {
    const grant = this.grants.get(input.grantId);
    if (!grant) throw new Error("GRANT_NOT_FOUND");
    if (grant.revokedAt === null) grant.revokedAt = input.at;
  }

  async recordAdjudication(_scope: AuthScope, adjudication: Adjudication): Promise<Ref<"adjudication">> {
    const parsed = AdjudicationSchema.parse(adjudication);
    const decision = this.decisions.get(parsed.decision.id);
    if (!decision) throw new Error("DECISION_NOT_FOUND");
    if (decision.subject.digest !== parsed.subject.digest) throw new Error("ADJUDICATION_SUBJECT_MISMATCH");
    if (
      decision.boundEffectDigest !== parsed.boundEffectDigest ||
      decision.qualifiersDigest !== parsed.qualifiersDigest
    ) {
      throw new Error("REVIEW_BINDING_MISMATCH");
    }
    const grant = [...this.grants.values()].find(
      (candidate) =>
        candidate.reviewerId === parsed.reviewerId && this.grantLive(candidate.grantId, decision, parsed.decidedAt),
    );
    if (!grant) throw new Error(`REVIEWER_NOT_QUALIFIED: ${parsed.reviewerId}`);
    if (this.adjudications.has(parsed.id)) throw new Error("IMMUTABLE_RECORD: adjudication");
    this.adjudications.set(parsed.id, { ...parsed, grantId: grant.grantId });
    return recordRef("adjudication", parsed);
  }

  async loadAdjudication(_scope: AuthScope, adjudicationId: string): Promise<Adjudication | null> {
    const stored = this.adjudications.get(adjudicationId);
    if (!stored) return null;
    const { grantId: _grant, ...adjudication } = stored;
    return adjudication;
  }

  /** Dependency edges derived from the stored records (upstream -> dependent), like the binding's edge rows. */
  private edges(): { from: string; to: string }[] {
    const edges: { from: string; to: string }[] = [];
    const key = (kind: string, id: string) => `${kind}:${id}`;
    for (const fragment of this.fragments.values())
      edges.push({ from: key("capture", fragment.capture.id), to: key("fragment", fragment.id) });
    for (const set of this.supportSets.values()) {
      for (const premise of set.required) {
        for (const fragment of premise.evidence)
          edges.push({ from: key("fragment", fragment.id), to: key("support_set", set.id) });
        for (const assertion of premise.derivedFrom)
          edges.push({ from: key("assertion", assertion.id), to: key("assertion", set.assertion.id) });
      }
      for (const fragment of set.contrary)
        edges.push({ from: key("fragment", fragment.id), to: key("support_set", set.id) });
      edges.push({ from: key("support_set", set.id), to: key("assertion", set.assertion.id) });
    }
    for (const run of this.runs.values()) {
      for (const assertion of run.report?.revision.assertions ?? []) {
        edges.push({ from: key("assertion", assertion.id), to: key("report", run.report?.revision.id ?? "") });
      }
    }
    for (const decision of this.decisions.values()) {
      edges.push({ from: key("report", decision.report.id), to: key("use_decision", decision.id) });
      if (decision.subject.kind === "assertion")
        edges.push({ from: key("assertion", decision.subject.id), to: key("use_decision", decision.id) });
      if (decision.supportSet)
        edges.push({ from: key("support_set", decision.supportSet.id), to: key("use_decision", decision.id) });
    }
    return edges;
  }

  async recordCorrection(_scope: AuthScope, input: CorrectionInput): Promise<CorrectionClosure> {
    const start = `${input.corrected.kind}:${input.corrected.id}`;
    const downstream = new Map<string, string[]>();
    for (const edge of this.edges()) downstream.set(edge.from, [...(downstream.get(edge.from) ?? []), edge.to]);
    const affected = new Set<string>();
    const queue = [start];
    while (queue.length > 0) {
      const next = queue.shift() as string;
      for (const child of downstream.get(next) ?? []) {
        if (affected.has(child)) continue;
        affected.add(child);
        queue.push(child);
      }
    }
    this.epoch += 1;
    const list = [...affected].sort().map((entry) => {
      const index = entry.indexOf(":");
      return { kind: entry.slice(0, index), id: entry.slice(index + 1) };
    });
    for (const entry of list) if (entry.kind === "use_decision") this.invalidated.add(entry.id);
    const fragmentIds = new Set([
      ...(input.corrected.kind === "fragment" ? [input.corrected.id] : []),
      ...list.filter((entry) => entry.kind === "fragment").map((entry) => entry.id),
    ]);
    const fragments = [...fragmentIds].flatMap((id) => {
      const fragment = this.fragments.get(id);
      return fragment ? [recordRef("fragment", fragment)] : [];
    });
    const reports = new Set(list.filter((entry) => entry.kind === "report").map((entry) => entry.id));
    const runs = [...this.runs.entries()]
      .filter(([, run]) => run.report !== null && reports.has(run.report.revision.id))
      .map(([runId, run]) => ({ runId, state: run.state }));
    return { invalidationId: `inv-${this.epoch}`, epoch: this.epoch, affected: list, fragments, runs };
  }

  readonly assessments = new Map<string, { record: ReportAssessmentRecord; artifact: Ref<"artifact"> }>();

  async recordAssessment(
    _scope: AuthScope,
    input: { record: ReportAssessmentRecord; artifact: Ref<"artifact">; operationId: string | null },
  ): Promise<Ref<"artifact">> {
    const existing = this.assessments.get(input.record.id);
    if (existing !== undefined && existing.artifact.digest !== input.artifact.digest) {
      throw new Error("IMMUTABLE_RECORD: report assessment");
    }
    this.require(input.record.runId);
    this.assessments.set(input.record.id, { record: input.record, artifact: input.artifact });
    return input.artifact;
  }

  async currentEpoch(): Promise<number> {
    return this.epoch;
  }

  private require(runId: string): MemoryRun {
    const run = this.runs.get(runId);
    if (!run) throw new Error("RUN_NOT_FOUND");
    return run;
  }
}

const clampRetry = (ms: number) => Math.min(300000, Math.max(100, Math.round(ms)));

/**
 * In-memory `OperationStore`: the same rules as the component's `transition_operation` (K01 transition table,
 * compare-and-set on revision, idempotent start and cancel). A test double, never deployment authority.
 */
export class InMemoryOperationStore implements OperationStore {
  private readonly records = new Map<string, OperationRecord>();

  async start(scope: AuthScope, input: OperationStart): Promise<OperationRecord> {
    const existing = [...this.records.values()].find(
      (record) =>
        record.status.handle.tenant === scope.tenant &&
        record.operation === input.operation &&
        record.requestId === input.requestId,
    );
    if (existing !== undefined) {
      if (existing.requestDigest !== input.requestDigest) {
        throw new OperationStoreError("REQUEST_CONFLICT", `request ${input.requestId} was started with other input`);
      }
      return existing;
    }
    const record: OperationRecord = {
      status: OperationStatusSchema.parse({
        handle: {
          protocolVersion: PROTOCOL_VERSION,
          tenant: scope.tenant,
          application: scope.application,
          binding: scope.binding,
          operationId: input.operationId,
        },
        state: "queued",
        revision: 1,
        createdAt: input.at,
        updatedAt: input.at,
        progressRef: null,
        pendingReviewRef: null,
        resultRef: null,
        error: null,
        unresolvedEffects: [],
        retryAfterMs: clampRetry(input.retryAfterMs),
        cancelRequestId: null,
      }),
      operation: input.operation,
      requestId: input.requestId,
      requestDigest: input.requestDigest,
      request: input.request,
      runId: input.runId,
      subject: input.subject,
    };
    this.records.set(`${scope.tenant}/${input.operationId}`, record);
    return record;
  }

  async get(scope: AuthScope, operationId: string): Promise<OperationRecord | null> {
    return this.records.get(`${scope.tenant}/${operationId}`) ?? null;
  }

  async transition(scope: AuthScope, input: OperationTransition): Promise<OperationRecord> {
    return this.apply(scope, input, null);
  }

  async cancel(
    scope: AuthScope,
    input: { operationId: string; cancelRequestId: string; at: string },
  ): Promise<OperationRecord> {
    const record = await this.require(scope, input.operationId);
    if (isTerminal(record.status.state) || record.status.cancelRequestId !== null) return record;
    return this.apply(
      scope,
      {
        operationId: input.operationId,
        expectedRevision: record.status.revision,
        to: record.status.state === "queued" ? "cancelled" : "cancelling",
        at: input.at,
      },
      input.cancelRequestId,
    );
  }

  private async apply(
    scope: AuthScope,
    input: OperationTransition,
    cancelRequestId: string | null,
  ): Promise<OperationRecord> {
    const record = await this.require(scope, input.operationId);
    if (record.status.revision !== input.expectedRevision) {
      throw new OperationStoreError(
        "REVISION_MISMATCH",
        `expected revision ${input.expectedRevision}, current ${record.status.revision}`,
      );
    }
    if (!canTransition(record.status.state, input.to)) {
      throw new OperationStoreError("ILLEGAL_TRANSITION", `${record.status.state} -> ${input.to}`);
    }
    const next = transitionStatus(record.status, {
      state: input.to,
      updatedAt: input.at,
      ...(input.progressRef !== undefined ? { progressRef: input.progressRef } : {}),
      ...(input.pendingReviewRef !== undefined ? { pendingReviewRef: input.pendingReviewRef } : {}),
      ...(input.resultRef !== undefined ? { resultRef: input.resultRef } : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
      ...(input.unresolvedEffects !== undefined ? { unresolvedEffects: [...input.unresolvedEffects] } : {}),
      ...(input.retryAfterMs !== undefined ? { retryAfterMs: clampRetry(input.retryAfterMs) } : {}),
      cancelRequestId: record.status.cancelRequestId ?? cancelRequestId,
    });
    const updated: OperationRecord = { ...record, status: next };
    this.records.set(`${scope.tenant}/${input.operationId}`, updated);
    return updated;
  }

  private async require(scope: AuthScope, operationId: string): Promise<OperationRecord> {
    const record = await this.get(scope, operationId);
    if (record === null) throw new OperationStoreError("OPERATION_NOT_FOUND", operationId);
    return record;
  }
}
