import {
  type Digest,
  type Origin,
  type Ref,
  canonicalJson,
  digestBytes,
  digestCanonical,
} from "@aiengineer/knowledge-operation-protocol";
import type { JsonValue } from "@aiengineer/knowledge-operation-protocol";
import {
  type AssertionVersion,
  AssertionVersionSchema,
  type AuthScope,
  type EvidenceFragment,
  EvidenceFragmentSchema,
  type FrozenReport,
  type Interval,
  MANIFEST_SCHEMA_VERSION,
  NORMALIZATION_VERSION,
  RENDERER_VERSION,
  REPORT_SCHEMA_VERSION,
  RUN_SCHEMA_VERSION,
  type ReportAggregate,
  type ReportLedger,
  type ReportRevision,
  ReportRevisionSchema,
  type FamilyBinding,
  type NormalizedValues,
  REVIEW_CONDITION,
  type RunManifest,
  RunManifestSchema,
  type SealSigner,
  type SealedRun,
  type SnapshotKind,
  type UseClass,
  authorityChallengeReasons,
  authorityGateRequired,
  NON_ENTAILED_KINDS,
  judgmentBasisGaps,
  judgmentPolicyFor,
  officialUse,
  type StructuredBody,
  type SupportEvaluation,
  type SupportSet,
  SupportSetSchema,
  USE_DECISION_SCHEMA_VERSION,
  type UseDecision,
  UseDecisionSchema,
  type VerificationObservation,
  VerificationObservationSchema,
  type VerificationRun,
  VerificationRunSchema,
  type VerificationTaskContract,
  VerificationTaskContractSchema,
  aggregateReport,
  authoritativeObservations,
  buildLedger,
  evaluateSupport,
  manifestDigest,
  recordRef,
  renderReport,
} from "@aiengineer/knowledge-research-core";
import {
  AUDITOR_INVENTORY_SCHEMA_VERSION,
  type AuditorInventory,
  AuditorInventorySchema,
  type CensusFinding,
  OBSERVATION_SCHEMA_VERSION,
  StructuredBodySchema,
  assessCensus,
  censusInputDigest,
  checkReportAgainstKind,
  findCensus,
} from "@aiengineer/knowledge-research-core";
import type { AdmissionOutcome, AuditorDiscovery, RecordCollision, ResearchBinding, RunContext } from "./ports.js";
import type { ReportKindCatalog } from "./report-kinds.js";
import type { SourceAuthorityCatalog } from "./source-authority.js";

/**
 * The research run coordinator (K04, SV-05/SV-06): one writer, one sealer, one oracle over a binding.
 *
 * Freeze the task -> open the run -> register evidence/assertions/support sets -> register the report (render,
 * freeze, custody, ledger, occurrences) -> append observations (producer, judge, auditor) -> seal the verification
 * snapshot (one head, compare-and-set) -> decide exact use from authoritative observations only -> the binding admits
 * the exact effect under the epoch lock. Nothing here calls a model; semantic observations are inputs.
 */
export class ResearchCoordinatorError extends Error {
  readonly code:
    | "RUN_ALREADY_SEALED"
    | "REPORT_REQUIRED"
    | "REPORT_ALREADY_REGISTERED"
    | "TASK_MISMATCH"
    | "SUBJECT_NOT_IN_REPORT"
    | "SUPPORT_REFUSED"
    | "SCHEMA_UNSUPPORTED"
    | "BODY_DIGEST_MISMATCH"
    | "REPORT_MISMATCH"
    | "DISCOVERY_INVALID"
    | "AUDITOR_ROLE_REQUIRED"
    | "RUN_NOT_SEALED"
    | "DECISION_NOT_FOUND"
    | "STALE_DECISION"
    | "REVIEW_BINDING_MISMATCH";
  readonly violations: readonly string[];
  constructor(code: ResearchCoordinatorError["code"], message: string, violations: readonly string[] = []) {
    super(`${code}: ${message}`);
    this.name = "ResearchCoordinatorError";
    this.code = code;
    this.violations = violations;
  }
}

export interface Clock {
  now(): string;
}

/** Wall clock in the K01 instant form (RFC 3339 UTC, no trailing zeros in the fraction). */
export const systemClock: Clock = {
  now: () => toInstant(new Date()),
};

export function toInstant(date: Date): string {
  return date.toISOString().replace(/\.(\d*?)0+Z$/, (_match, digits: string) => (digits ? `.${digits}Z` : "Z"));
}

export interface RegisterReportInput {
  readonly runId: string;
  readonly reportId: string;
  readonly revision: number;
  readonly kind: Ref<"report_kind">;
  readonly structuredBody: StructuredBody;
  readonly assertions: readonly Ref<"assertion">[];
  readonly timeCoverage: { world: Interval | null; observed: Interval | null; knowledgeHead: string | null };
  readonly supersedes: Ref<"report"> | null;
}

export interface RegisteredReport {
  readonly report: Ref<"report">;
  readonly revision: ReportRevision;
  readonly ledger: ReportLedger;
  readonly frozen: FrozenReport;
}

export interface SealInput {
  readonly runId: string;
  readonly build: { buildId: string; runtime: string; dirty: boolean };
  readonly signer: string;
  readonly replayOf?: Ref<"verification_run"> | null;
}

export interface ReportUseInput {
  readonly runId: string;
  readonly use: string;
  readonly audience: string;
  readonly boundEffectDigest: Digest;
  readonly targetSchema: string;
  /** OQ2: string | safe integer | boolean | null per name (`safeInteger(n)` for integers). */
  readonly normalizedValues: NormalizedValues;
  readonly policy: Ref<"policy">;
  readonly rubric: Ref<"rubric">;
  readonly expiresAt?: string | null;
}

export interface AssertionUseInput extends ReportUseInput {
  readonly assertion: Ref<"assertion">;
}

export interface ReportUseDecision {
  readonly decision: UseDecision;
  readonly ref: Ref<"use_decision">;
  readonly aggregate: ReportAggregate;
  /** The census the aggregate used, derived from recorded auditor observations. */
  readonly census: CensusFinding;
}

export interface AuditInput {
  readonly runId: string;
  readonly auditor: AuditorDiscovery;
  /** Evidence supplied independently of the producer (the auditor may also retrieve its own). */
  readonly evidence?: readonly EvidenceFragment[];
}

export interface AuditedReport {
  readonly observation: VerificationObservation;
  readonly ref: Ref<"observation">;
  readonly inventory: Ref<"artifact">;
  readonly census: CensusFinding;
}

export interface ReportAssessment {
  readonly report: Ref<"report">;
  readonly aggregate: ReportAggregate;
  readonly census: CensusFinding;
}

export interface AssertionUseDecision {
  readonly decision: UseDecision;
  readonly ref: Ref<"use_decision">;
  readonly evaluation: SupportEvaluation;
}

function storeScope(scope: AuthScope) {
  return { tenant: scope.tenant, binding: scope.binding };
}

export interface CoordinatorOptions {
  /** K07: the only sealer. Every manifest (verification and successor snapshots) is signed by it. */
  readonly signer: SealSigner;
  /** K08 source authority rules and use classes; without it every use is `internal` (no SV-07 gate below critical). */
  readonly authority?: SourceAuthorityCatalog | null;
}

/** The evidence-only disposition of a decision subject (before any review), with its blocking conditions. */
export interface SubjectEvaluation {
  readonly disposition: "admitted" | "held" | "rejected";
  readonly conditions: readonly string[];
  readonly supportSet: Ref<"support_set"> | null;
  readonly qualifiersDigest: Digest | null;
  readonly reviewRequired: boolean;
}

export class ResearchCoordinator {
  private readonly signer: SealSigner;
  private readonly authority: SourceAuthorityCatalog | null;

  constructor(
    private readonly binding: ResearchBinding,
    private readonly clock: Clock,
    private readonly reportKinds: ReportKindCatalog,
    options: CoordinatorOptions,
  ) {
    this.signer = options.signer;
    this.authority = options.authority ?? null;
  }

  /** The K08 use class and review requirement of a (use, audience) at the task's risk. */
  useClassFor(
    task: VerificationTaskContract,
    use: string,
    audience: string,
  ): { useClass: UseClass; reviewRequired: boolean } {
    if (this.authority === null) return { useClass: "internal", reviewRequired: false };
    return this.authority.useClass({ use, audience, risk: task.minimumRisk });
  }

  async openRun(
    scope: AuthScope,
    input: { task: VerificationTaskContract; originatingOrigin: Origin },
  ): Promise<{ runId: string; task: Ref<"task"> }> {
    const task = VerificationTaskContractSchema.parse(input.task);
    const taskRef = await this.binding.freezeTask(scope, task);
    // The opening instant is recorded once; the sealed run record reads it back so a retried seal is byte-identical.
    const runId = await this.binding.openRun(scope, {
      task: taskRef,
      originatingOrigin: input.originatingOrigin,
      openedAt: this.clock.now(),
    });
    return { runId, task: taskRef };
  }

  /**
   * W1 D19: every deterministic check of one registration, with NO write. `report.register` runs it before the effect
   * is bound and before any record is written, so a refused registration (schema, report kind, body rendering) leaves
   * nothing behind and a corrected retry never collides with ids an earlier refusal took. The writes that follow can
   * then fail only on a genuine id collision (typed `EFFECT_CONFLICT`) or an infrastructure fault; every put is
   * write-once and idempotent for identical bytes, so a retry of the same content heals a partial write.
   */
  validateRegistration(
    scope: AuthScope,
    input: {
      readonly task: unknown;
      readonly fragments: readonly unknown[];
      readonly assertions: readonly unknown[];
      readonly supportSets: readonly unknown[];
      readonly kind: Ref<"report_kind">;
      readonly structuredBody: unknown;
      readonly reportId: string;
      readonly revision: number;
      readonly timeCoverage: RegisterReportInput["timeCoverage"];
      readonly supersedes: Ref<"report"> | null;
    },
  ): void {
    const task = VerificationTaskContractSchema.parse(input.task);
    for (const fragment of input.fragments) EvidenceFragmentSchema.parse(fragment);
    const assertions = input.assertions.map((assertion) => AssertionVersionSchema.parse(assertion));
    for (const set of input.supportSets) SupportSetSchema.parse(set);
    const kind = this.reportKinds.resolve(storeScope(scope), input.kind);
    if (kind === null) {
      throw new ResearchCoordinatorError("SCHEMA_UNSUPPORTED", `unknown report kind ${input.kind.id}`, [
        `report_kind_unknown:${input.kind.id}`,
      ]);
    }
    const body = StructuredBodySchema.parse(input.structuredBody);
    const check = checkReportAgainstKind({
      kind,
      task,
      body,
      declared: assertions.map((assertion) => recordRef("assertion", assertion)),
      assertions,
    });
    if (!check.ok) {
      throw new ResearchCoordinatorError(
        "SCHEMA_UNSUPPORTED",
        `draft does not satisfy ${input.kind.id}: ${check.violations.join(", ")}`,
        check.violations,
      );
    }
    // The rest of `registerReport`, dry: render, the producer ledger over the frozen body, the revision record (its
    // custody refs stand in by digest: custody names an artifact by its exact bytes).
    const frozen = renderReport(body);
    const artifact = (bytes: Uint8Array): Ref<"artifact"> => {
      const digest = digestBytes(bytes);
      return {
        kind: "artifact",
        id: `artifact-${digest.slice(7, 31)}`,
        version: "artifact.v1",
        digest,
        tenant: scope.tenant,
        binding: scope.binding,
      };
    };
    const bodyRef = artifact(frozen.bytes);
    const ledger = buildLedger({
      frozen,
      body: bodyRef,
      id: `${input.reportId}-r${input.revision}-ledger`,
      tenant: scope.tenant,
      binding: scope.binding,
    });
    const revisionId = `${input.reportId}-r${input.revision}`;
    if (input.supersedes !== null && input.supersedes.id === revisionId) {
      throw new ResearchCoordinatorError("SCHEMA_UNSUPPORTED", "a revision cannot supersede itself", [
        "supersedes_self",
      ]);
    }
    ReportRevisionSchema.parse({
      schemaVersion: REPORT_SCHEMA_VERSION,
      id: revisionId,
      tenant: scope.tenant,
      binding: scope.binding,
      kind: input.kind,
      task: recordRef("task", task),
      structuredBody: artifact(Buffer.from(JSON.stringify(input.structuredBody), "utf8")),
      body: bodyRef,
      bodyDigest: frozen.bodyDigest,
      renderer: RENDERER_VERSION,
      normalization: NORMALIZATION_VERSION,
      ledger: artifact(Buffer.from(JSON.stringify(ledger), "utf8")),
      assertions: assertions.map((assertion) => recordRef("assertion", assertion)),
      timeCoverage: input.timeCoverage,
      derivationCandidates: [],
      supersedes: input.supersedes,
    } satisfies ReportRevision);
  }

  /**
   * W1 D19 (review B2): the registration's record ids and digests against what the store already holds, read before
   * the first write. A record id held with other bytes (`record_id_conflict`) or these bytes held under another id
   * (`record_digest_exists`) is answered here, so the writes that follow never collide mid-way (only a concurrent
   * registration can still race one; the write-once puts then refuse the same way).
   */
  async registrationCollisions(
    scope: AuthScope,
    input: {
      readonly task: VerificationTaskContract;
      readonly fragments: readonly EvidenceFragment[];
      readonly assertions: readonly AssertionVersion[];
      readonly supportSets: readonly SupportSet[];
    },
  ): Promise<readonly RecordCollision[]> {
    return this.binding.recordCollisions(scope, [
      { kind: "task", id: input.task.id, digest: recordRef("task", input.task).digest },
      ...input.fragments.map((record) => ({
        kind: "fragment" as const,
        id: record.id,
        digest: recordRef("fragment", record).digest,
      })),
      ...input.assertions.map((record) => ({
        kind: "assertion" as const,
        id: record.id,
        digest: recordRef("assertion", record).digest,
      })),
      ...input.supportSets.map((record) => ({
        kind: "support_set" as const,
        id: record.id,
        digest: recordRef("support_set", record).digest,
      })),
    ]);
  }

  async registerEvidence(
    scope: AuthScope,
    input: {
      fragments?: readonly EvidenceFragment[];
      assertions?: readonly AssertionVersion[];
      supportSets?: readonly SupportSet[];
    },
  ): Promise<{ fragments: Ref<"fragment">[]; assertions: Ref<"assertion">[]; supportSets: Ref<"support_set">[] }> {
    const fragments: Ref<"fragment">[] = [];
    for (const fragment of input.fragments ?? []) {
      fragments.push(await this.binding.putFragment(scope, EvidenceFragmentSchema.parse(fragment)));
    }
    const assertions: Ref<"assertion">[] = [];
    for (const assertion of input.assertions ?? []) {
      assertions.push(await this.binding.putAssertion(scope, AssertionVersionSchema.parse(assertion)));
    }
    const supportSets: Ref<"support_set">[] = [];
    for (const set of input.supportSets ?? []) {
      supportSets.push(await this.binding.putSupportSet(scope, SupportSetSchema.parse(set)));
    }
    return { fragments, assertions, supportSets };
  }

  /** Render deterministically, freeze exact bytes into custody, build the producer ledger and mint the revision. */
  async registerReport(scope: AuthScope, input: RegisterReportInput): Promise<RegisteredReport> {
    const context = await this.binding.loadRunContext(scope, input.runId);
    if (context.state === "sealed" || context.state === "superseded") {
      throw new ResearchCoordinatorError("RUN_ALREADY_SEALED", "a sealed run gets a successor run, not a new report");
    }
    if (context.report !== null) {
      throw new ResearchCoordinatorError("REPORT_ALREADY_REGISTERED", "one report revision per run");
    }
    // K08: the draft must satisfy its pinned report kind before anything is frozen.
    const kind = this.reportKinds.resolve(storeScope(scope), input.kind);
    if (kind === null) {
      throw new ResearchCoordinatorError("SCHEMA_UNSUPPORTED", `unknown report kind ${input.kind.id}`, [
        `report_kind_unknown:${input.kind.id}`,
      ]);
    }
    const body = StructuredBodySchema.parse(input.structuredBody);
    const check = checkReportAgainstKind({
      kind,
      task: context.task,
      body,
      declared: input.assertions,
      assertions: await this.binding.loadAssertions(scope, input.assertions),
    });
    if (!check.ok) {
      throw new ResearchCoordinatorError(
        "SCHEMA_UNSUPPORTED",
        `draft does not satisfy ${input.kind.id}: ${check.violations.join(", ")}`,
        check.violations,
      );
    }
    const frozen = renderReport(body);
    const bodyRef = await this.binding.custody.put(scope, frozen.bytes, "text/markdown; charset=utf-8");
    if (bodyRef.digest !== frozen.bodyDigest) {
      throw new Error("CUSTODY_DIGEST_MISMATCH: custody returned a different digest for the frozen body");
    }
    const structured = await this.binding.custody.put(
      scope,
      Buffer.from(JSON.stringify(input.structuredBody), "utf8"),
      "application/json",
    );
    const ledger = buildLedger({
      frozen,
      body: bodyRef,
      id: `${input.reportId}-r${input.revision}-ledger`,
      tenant: scope.tenant,
      binding: scope.binding,
    });
    const ledgerArtifact = await this.binding.custody.put(
      scope,
      Buffer.from(JSON.stringify(ledger), "utf8"),
      "application/json",
    );
    const taskRef = recordRef("task", context.task);
    const revision = ReportRevisionSchema.parse({
      schemaVersion: REPORT_SCHEMA_VERSION,
      id: `${input.reportId}-r${input.revision}`,
      tenant: scope.tenant,
      binding: scope.binding,
      kind: input.kind,
      task: taskRef,
      structuredBody: structured,
      body: bodyRef,
      bodyDigest: frozen.bodyDigest,
      renderer: RENDERER_VERSION,
      normalization: NORMALIZATION_VERSION,
      ledger: ledgerArtifact,
      assertions: [...input.assertions],
      timeCoverage: input.timeCoverage,
      derivationCandidates: [],
      supersedes: input.supersedes,
    } satisfies ReportRevision);
    const report = await this.binding.putReportRevision(scope, {
      runId: input.runId,
      reportId: input.reportId,
      revision: input.revision,
      record: revision,
      ledger,
    });
    return { report, revision, ledger, frozen };
  }

  async observe(scope: AuthScope, runId: string, observation: VerificationObservation): Promise<Ref<"observation">> {
    return this.binding.appendObservation(scope, runId, VerificationObservationSchema.parse(observation));
  }

  /**
   * Final census (design §3.2, SV-06): load the exact frozen body bytes from custody and verify them against the
   * revision; re-render the structured body (pinned renderer) to recover the structural units; run the independent
   * auditor discovery pass (it never sees the producer ledger); reconcile and screen; freeze the auditor inventory into
   * custody; append ONE `auditor` census observation on the report. A changed body (any post-freeze edit) refuses.
   */
  async auditReport(scope: AuthScope, input: AuditInput): Promise<AuditedReport> {
    const context = await this.binding.loadRunContext(scope, input.runId);
    if (context.report === null) {
      throw new ResearchCoordinatorError("REPORT_REQUIRED", "the census audits a registered report revision");
    }
    if (context.state === "sealed" || context.state === "superseded") {
      throw new ResearchCoordinatorError("RUN_ALREADY_SEALED", "a sealed run's census belongs to a successor run");
    }
    const { revision } = context.report;
    const reportRef = recordRef("report", revision);
    const { frozen, bytes } = await this.loadFrozen(scope, revision);
    const discovery = await input.auditor.discover(scope, {
      task: context.task,
      report: reportRef,
      body: { ref: revision.body, bytes, text: frozen.text },
      units: frozen.units,
      evidence: input.evidence ?? [],
      assertions: context.assertions,
    });
    if (discovery.evaluator.role !== "auditor") {
      throw new ResearchCoordinatorError("AUDITOR_ROLE_REQUIRED", `census evaluator role ${discovery.evaluator.role}`);
    }
    const inventory: AuditorInventory = AuditorInventorySchema.parse({
      schemaVersion: AUDITOR_INVENTORY_SCHEMA_VERSION,
      id: `${revision.id}-auditor-inventory`,
      tenant: scope.tenant,
      binding: scope.binding,
      body: revision.body,
      occurrences: [...discovery.occurrences],
      explanations: [...discovery.explanations],
      unitExplanations: [...discovery.unitExplanations],
    } satisfies AuditorInventory);
    const inventoryRef = await this.binding.custody.put(
      scope,
      Buffer.from(canonicalJson(inventory as unknown as JsonValue), "utf8"),
      "application/json",
    );
    const assessed = assessCensus({
      frozen,
      producer: context.occurrences,
      assertions: context.assertions,
      discovered: inventory.occurrences,
      explanations: inventory.explanations,
      unitExplanations: inventory.unitExplanations,
      producerInventory: revision.ledger,
      auditorInventory: inventoryRef,
      recall: discovery.recall,
      // K08: the kind declares its framing sections; the census excludes them from the factual inventory, with reasons.
      framing: this.reportKinds.resolve(storeScope(scope), revision.kind)?.framingSections ?? [],
      // R1 F5: high/critical tasks hold quotes the deterministic cues cannot screen (`unable_to_screen`).
      minimumRisk: context.task.minimumRisk,
    });
    if (!assessed.ok) {
      const code = assessed.code === "DISCOVERY_INVALID" ? "DISCOVERY_INVALID" : "BODY_DIGEST_MISMATCH";
      throw new ResearchCoordinatorError(code, assessed.detail.join(", "), assessed.detail);
    }
    const inputDigest = censusInputDigest({
      bodyDigest: revision.bodyDigest,
      producerInventory: revision.ledger.digest,
      auditorInventory: inventoryRef.digest,
    });
    const recall = discovery.recall;
    const observation = VerificationObservationSchema.parse({
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      id: `census-${revision.id}-${inputDigest.slice(7, 23)}`,
      tenant: scope.tenant,
      binding: scope.binding,
      target: reportRef,
      inputDigest,
      qualifiersDigest: null,
      method: discovery.method,
      evaluator: discovery.evaluator,
      rationale: discovery.rationale,
      limitations: [
        recall.label === "measured"
          ? `recall measured (${recall.numerator}/${recall.denominator}), not proven`
          : `recall unmeasured: ${recall.reason}`,
        ...discovery.limitations,
      ],
      evidence: (input.evidence ?? []).map((fragment) => recordRef("fragment", fragment)),
      rawResponse: discovery.rawResponse,
      usage: discovery.usage,
      recordedAt: this.clock.now(),
      property: "census",
      outcome: assessed.outcome,
    });
    const ref = await this.binding.appendObservation(scope, input.runId, observation);
    const census = findCensus({ report: revision, observations: [...context.observations, observation] });
    return { observation, ref, inventory: inventoryRef, census };
  }

  /**
   * Report-level aggregation over authoritative observations with the census derived from recorded auditor
   * observations. Re-verifies the frozen body in custody first: a post-freeze or post-seal edit refuses.
   */
  async assessReport(scope: AuthScope, runId: string): Promise<ReportAssessment> {
    const context = await this.binding.loadRunContext(scope, runId);
    if (context.report === null) {
      throw new ResearchCoordinatorError("REPORT_REQUIRED", "assessment needs a registered report revision");
    }
    return this.aggregateContext(scope, context);
  }

  private async aggregateContext(
    scope: AuthScope,
    context: RunContext,
    useClass?: UseClass,
    use?: { readonly use: string; readonly audience: string },
  ): Promise<ReportAssessment> {
    if (context.report === null) throw new ResearchCoordinatorError("REPORT_REQUIRED", "no report revision");
    const { revision } = context.report;
    if (!(await this.binding.custody.verify(scope, revision.body)) || revision.body.digest !== revision.bodyDigest) {
      throw new ResearchCoordinatorError("BODY_DIGEST_MISMATCH", "custody no longer holds the frozen body bytes");
    }
    const census = findCensus({ report: revision, observations: context.observations });
    const aggregate = aggregateReport({
      scope: storeScope(scope),
      task: context.task,
      occurrences: context.occurrences,
      assertions: context.assertions,
      supportSets: context.supportSets,
      observations: context.observations,
      census,
      report: recordRef("report", revision),
      useClass: useClass ?? this.useClassFor(context.task, context.task.use, context.task.audience).useClass,
      use: use?.use ?? context.task.use,
      audience: use?.audience ?? context.task.audience,
      judgmentPolicies: this.authority?.judgmentPolicies ?? null,
    });
    return { report: recordRef("report", revision), aggregate, census };
  }

  private async loadFrozen(
    scope: AuthScope,
    revision: ReportRevision,
  ): Promise<{ frozen: FrozenReport; bytes: Uint8Array }> {
    const bytes = await this.binding.custody.get(scope, revision.body);
    if (digestBytes(bytes) !== revision.bodyDigest || revision.body.digest !== revision.bodyDigest) {
      throw new ResearchCoordinatorError("BODY_DIGEST_MISMATCH", "custody body bytes differ from the frozen revision");
    }
    const structuredBytes = await this.binding.custody.get(scope, revision.structuredBody);
    if (digestBytes(structuredBytes) !== revision.structuredBody.digest) {
      throw new ResearchCoordinatorError("BODY_DIGEST_MISMATCH", "custody structured body differs from the revision");
    }
    const structured = StructuredBodySchema.parse(JSON.parse(Buffer.from(structuredBytes).toString("utf8")));
    const frozen = renderReport(structured);
    if (frozen.bodyDigest !== revision.bodyDigest || frozen.renderer !== revision.renderer) {
      throw new ResearchCoordinatorError(
        "BODY_DIGEST_MISMATCH",
        "the structured body no longer renders to the frozen bytes",
      );
    }
    return { frozen, bytes };
  }

  /** Seal the verification snapshot: one head, families bound by digest, the manifest never containing its own seal. */
  async sealVerificationSnapshot(
    scope: AuthScope,
    input: SealInput,
  ): Promise<{ sealed: SealedRun; run: Ref<"verification_run"> }> {
    const context = await this.binding.loadRunContext(scope, input.runId);
    if (context.report === null) {
      throw new ResearchCoordinatorError("REPORT_REQUIRED", "a verification snapshot binds a report revision");
    }
    if (context.head !== null) {
      throw new ResearchCoordinatorError("RUN_ALREADY_SEALED", `run ${input.runId} already has head ${context.head}`);
    }
    const now = this.clock.now();
    const reportRef = recordRef("report", context.report.revision);
    const observationRefs = context.observations.map((observation) => recordRef("observation", observation));
    const family = async (name: string, value: JsonValue): Promise<Ref<"artifact">> =>
      this.binding.custody.put(scope, Buffer.from(JSON.stringify({ family: name, value }), "utf8"), "application/json");
    const capture = await family(
      "capture",
      context.supportSets.flatMap((set) => set.required.flatMap((p) => p.evidence.map((e) => e.digest))).sort(),
    );
    const claims = await family("claims", {
      assertions: context.assertions.map((assertion) => recordRef("assertion", assertion).digest),
      supportSets: context.supportSets.map((set) => recordRef("support_set", set).digest),
    });
    const observations = await family(
      "observations",
      observationRefs.map((ref) => ref.digest),
    );
    const cost = context.observations.reduce(
      (sum, observation) => ({
        providerCalls: sum.providerCalls + observation.usage.providerCalls,
        tokens: sum.tokens + observation.usage.tokens,
        costUsd: addDecimal(sum.costUsd, observation.usage.costUsd),
      }),
      { providerCalls: 0, tokens: 0, costUsd: "0" },
    );
    const run = VerificationRunSchema.parse({
      schemaVersion: RUN_SCHEMA_VERSION,
      id: input.runId,
      tenant: scope.tenant,
      binding: scope.binding,
      task: recordRef("task", context.task),
      report: reportRef,
      predecessor: null,
      replayOf: input.replayOf ?? null,
      operationId: context.operationId,
      missionCorrelation: context.missionCorrelation,
      build: input.build,
      obligationDenominator: context.task.obligations.map((obligation) => obligation.id),
      candidateDenominator: context.occurrences.length,
      observations: observationRefs,
      cost,
      startedAt: context.openedAt,
    } satisfies VerificationRun);
    // The run record is deterministic from stored facts and is written with the manifest and head in ONE binding
    // transaction (`seal`): a failure anywhere before commit leaves nothing behind and the retry is identical.
    const runRef = recordRef("verification_run", run);
    const manifest = RunManifestSchema.parse({
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      id: `${input.runId}-m1`,
      tenant: scope.tenant,
      binding: scope.binding,
      snapshot: "verification_snapshot",
      run: runRef,
      report: reportRef,
      predecessor: null,
      families: [
        { family: "capture", ref: capture },
        { family: "claims", ref: claims },
        { family: "report", ref: reportRef },
        { family: "observations", ref: observations },
      ],
      createdAt: now,
    } satisfies RunManifest);
    // K07: a detached Ed25519 signature over {manifestDigest, signer, signedAt, keyId}; the binding verifies it against
    // the pinned key before the compare-and-set and again on every load.
    const seal = await this.signer.sign(manifestDigest(manifest), { signer: input.signer, signedAt: now });
    const sealed = await this.binding.seal(scope, { runId: input.runId, run, manifest, seal, expectedHead: null });
    return { sealed, run: runRef };
  }

  /**
   * Append a signed successor manifest (decision/admission snapshot for a review, correction snapshot for a known
   * correction) that references the committed head; sealed history is never mutated (design §6).
   */
  async sealSuccessor(
    scope: AuthScope,
    input: {
      runId: string;
      snapshot: Exclude<SnapshotKind, "verification_snapshot">;
      families: FamilyBinding[];
      signer: string;
    },
  ): Promise<SealedRun> {
    const context = await this.binding.loadRunContext(scope, input.runId);
    const head = context.manifests[context.manifests.length - 1];
    if (context.run === null || context.report === null || head === undefined || context.head === null) {
      throw new ResearchCoordinatorError("RUN_NOT_SEALED", "a successor manifest follows the verification snapshot");
    }
    const now = this.clock.now();
    const manifest = RunManifestSchema.parse({
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      id: `${input.runId}-m${context.manifests.length + 1}`,
      tenant: scope.tenant,
      binding: scope.binding,
      snapshot: input.snapshot,
      run: recordRef("verification_run", context.run),
      report: recordRef("report", context.report.revision),
      predecessor: recordRef("run_manifest", head.manifest),
      families: input.families,
      createdAt: now,
    } satisfies RunManifest);
    const seal = await this.signer.sign(manifestDigest(manifest), { signer: input.signer, signedAt: now });
    return this.binding.seal(scope, {
      runId: input.runId,
      run: context.run,
      manifest,
      seal,
      expectedHead: context.head,
    });
  }

  /** Report-level exact use: admitted only when every required obligation is covered by authoritative observations. */
  async decideReportUse(scope: AuthScope, input: ReportUseInput): Promise<ReportUseDecision> {
    const context = await this.binding.loadRunContext(scope, input.runId);
    if (context.report === null || context.head === null) {
      throw new ResearchCoordinatorError("REPORT_REQUIRED", "a use decision references a sealed run with a report");
    }
    // The census is derived from recorded auditor observations; a caller can no longer supply one.
    const { useClass, reviewRequired } = this.useClassFor(context.task, input.use, input.audience);
    const { aggregate, census } = await this.aggregateContext(scope, context, useClass, input);
    const epoch = await this.binding.currentEpoch(scope);
    // WI-03 (OC-D112): a judgment-covered obligation under an official use needs a qualified review; approval is
    // never fact entailment, so the decision names every judgment-covered obligation permanently.
    const judgmentReview = aggregate.judgmentCovered.length > 0 && officialUse(context.task, useClass);
    const reasons = [
      ...(reviewRequired || judgmentReview ? [REVIEW_CONDITION] : []),
      ...aggregate.judgmentCovered.map((id) => `judgment_not_entailed:${id}`),
      ...aggregate.judgmentPolicies.map((policy) => `judgment_policy:${policy}`),
      ...(census.status === "assessed" ? census.holds.map((hold) => `census:${hold}`) : [`census:${census.status}`]),
      ...aggregate.unmetRequired.map((id) => `unmet_required:${id}`),
      ...aggregate.heldRequired.map((id) => `held_required:${id}`),
      ...Object.entries(aggregate.holdsByReason).map(([reason, count]) => `${reason}:${count}`),
    ];
    const reportRef = recordRef("report", context.report.revision);
    const decisionId = `ud-${input.runId}-${digestBytes(`${input.use}|${input.audience}|${input.boundEffectDigest}|${epoch}`).slice(7, 23)}`;
    // Read-through (WI-03 B2): the id is deterministic over (run, use, audience, effect, epoch), so a
    // retry after a crash answers the recorded decision instead of re-minting it with a new clock.
    const recorded = await this.binding.loadDecision(scope, decisionId);
    if (recorded !== null) {
      return { decision: recorded.decision, ref: recordRef("use_decision", recorded.decision), aggregate, census };
    }
    const decision = UseDecisionSchema.parse({
      schemaVersion: USE_DECISION_SCHEMA_VERSION,
      id: decisionId,
      tenant: scope.tenant,
      binding: scope.binding,
      subject: reportRef,
      report: reportRef,
      qualifiersDigest: null,
      supportSet: null,
      run: recordRef("verification_run", this.runRecord(context)),
      boundEffectDigest: input.boundEffectDigest,
      use: input.use,
      audience: input.audience,
      normalizedValues: input.normalizedValues,
      targetSchema: input.targetSchema,
      // Missing evidence is not a contradiction (design §1): only a contradiction or an L0 integrity failure rejects.
      disposition: reportDisposition(aggregate),
      conditions: reasons,
      policy: input.policy,
      rubric: input.rubric,
      revocationEpoch: epoch,
      decidedAt: this.clock.now(),
      expiresAt: input.expiresAt ?? null,
      reviewer: null,
    } satisfies UseDecision);
    const ref = await this.binding.recordDecision(scope, decision);
    return { decision, ref, aggregate, census };
  }

  /** Assertion-level exact use: the selected support set and qualifiers digest are bound into the decision. */
  async decideAssertionUse(scope: AuthScope, input: AssertionUseInput): Promise<AssertionUseDecision> {
    const context = await this.binding.loadRunContext(scope, input.runId);
    if (context.report === null || context.head === null) {
      throw new ResearchCoordinatorError("REPORT_REQUIRED", "a use decision references a sealed run with a report");
    }
    const assertion = context.assertions.find(
      (candidate) => recordRef("assertion", candidate).digest === input.assertion.digest,
    );
    if (assertion === undefined) {
      throw new ResearchCoordinatorError(
        "SUBJECT_NOT_IN_REPORT",
        `assertion ${input.assertion.id} is not in run ${input.runId}`,
      );
    }
    const { evaluation, disposition, conditions, judgmentReview } = this.evaluateAssertion(
      scope,
      context,
      assertion,
      input,
    );
    const { reviewRequired } = this.useClassFor(context.task, input.use, input.audience);
    const epoch = await this.binding.currentEpoch(scope);
    const reportRef = recordRef("report", context.report.revision);
    const decisionId = `ud-${input.runId}-${digestBytes(`${input.assertion.digest}|${input.use}|${input.boundEffectDigest}|${epoch}`).slice(7, 23)}`;
    const recorded = await this.binding.loadDecision(scope, decisionId);
    if (recorded !== null) {
      return { decision: recorded.decision, ref: recordRef("use_decision", recorded.decision), evaluation };
    }
    const decision = UseDecisionSchema.parse({
      schemaVersion: USE_DECISION_SCHEMA_VERSION,
      id: decisionId,
      tenant: scope.tenant,
      binding: scope.binding,
      subject: input.assertion,
      report: reportRef,
      qualifiersDigest: evaluation.qualifiersDigest,
      // Checkpoint A: a held decision with no passing support set binds null, never the first set by position.
      supportSet: evaluation.selected,
      run: recordRef("verification_run", this.runRecord(context)),
      boundEffectDigest: input.boundEffectDigest,
      use: input.use,
      audience: input.audience,
      normalizedValues: input.normalizedValues,
      targetSchema: input.targetSchema,
      disposition,
      conditions: [...(reviewRequired || judgmentReview ? [REVIEW_CONDITION] : []), ...conditions],
      policy: input.policy,
      rubric: input.rubric,
      revocationEpoch: epoch,
      decidedAt: this.clock.now(),
      expiresAt: input.expiresAt ?? null,
      reviewer: null,
    } satisfies UseDecision);
    const ref = await this.binding.recordDecision(scope, decision);
    return { decision, ref, evaluation };
  }

  /** Evidence-only evaluation of one assertion for a use (SV-07 gate, OQ4), without any review requirement. */
  private evaluateAssertion(
    scope: AuthScope,
    context: RunContext,
    assertion: AssertionVersion,
    input: { use: string; audience: string },
  ): {
    evaluation: Extract<SupportEvaluation, { ok: true }>;
    disposition: "admitted" | "held";
    conditions: string[];
    judgmentReview: boolean;
  } {
    const authoritative = authoritativeObservations(context.observations);
    const evaluation = evaluateSupport({
      scope: storeScope(scope),
      assertion,
      assertions: context.assertions,
      supportSets: context.supportSets,
      observations: authoritative,
    });
    if (!evaluation.ok) {
      throw new ResearchCoordinatorError("SUPPORT_REFUSED", `${evaluation.code}: ${evaluation.reason}`);
    }
    const { useClass } = this.useClassFor(context.task, input.use, input.audience);
    const gate =
      evaluation.passes && authorityGateRequired(context.task, useClass)
        ? authorityChallengeReasons({ assertion, selectedSet: evaluation.selected, observations: authoritative })
        : [];
    const official = officialUse(context.task, useClass);
    // WI-03 (OC-D112): an official use of a recommendation/forecast needs an admitting judgment policy and a typed basis
    // that meets it; it is then admissible only after a qualified review, and the decision says it is not entailed.
    const policy =
      official && NON_ENTAILED_KINDS.has(assertion.kind)
        ? judgmentPolicyFor(this.authority?.judgmentPolicies ?? null, {
            use: input.use,
            audience: input.audience,
            useClass,
            kind: assertion.kind,
          })
        : null;
    const gaps = policy === null ? [] : judgmentBasisGaps(policy, assertion);
    const judgment = policy !== null && gaps.length === 0;
    const nonEntailed = official && NON_ENTAILED_KINDS.has(assertion.kind) && !judgment;
    const conditions = [
      ...evaluation.reasons,
      ...gate,
      ...(nonEntailed ? (policy === null ? ["non_entailed"] : ["judgment_basis_incomplete", ...gaps]) : []),
      ...(judgment && policy !== null
        ? ["judgment_not_entailed", `judgment_policy:${policy.id}@${policy.version}`]
        : []),
    ];
    const admitted =
      evaluation.passes &&
      (evaluation.factEntailed || judgment) &&
      !evaluation.materialConflict &&
      gate.length === 0 &&
      !nonEntailed;
    return { evaluation, disposition: admitted ? "admitted" : "held", conditions, judgmentReview: judgment };
  }

  /**
   * Re-derive the evidence-only disposition of a recorded decision's subject from its sealed run (used by review:
   * a reviewer's approval satisfies `review_required` only; it never waives mechanics, design §9).
   */
  async evaluateSubject(scope: AuthScope, decision: UseDecision): Promise<SubjectEvaluation> {
    const context = await this.binding.loadRunContext(scope, decision.run.id);
    if (context.report === null || context.head === null) {
      throw new ResearchCoordinatorError("RUN_NOT_SEALED", "a decision subject is evaluated on its sealed run");
    }
    const { reviewRequired, useClass } = this.useClassFor(context.task, decision.use, decision.audience);
    if (decision.subject.kind === "report") {
      const { aggregate } = await this.aggregateContext(scope, context, useClass, decision);
      return {
        disposition: reportDisposition(aggregate),
        conditions: [
          ...aggregate.unmetRequired.map((id) => `unmet_required:${id}`),
          ...aggregate.heldRequired.map((id) => `held_required:${id}`),
          ...aggregate.judgmentCovered.map((id) => `judgment_not_entailed:${id}`),
        ],
        supportSet: null,
        qualifiersDigest: null,
        reviewRequired: reviewRequired || (aggregate.judgmentCovered.length > 0 && officialUse(context.task, useClass)),
      };
    }
    const assertion = context.assertions.find(
      (candidate) => recordRef("assertion", candidate).digest === decision.subject.digest,
    );
    if (assertion === undefined) {
      throw new ResearchCoordinatorError("SUBJECT_NOT_IN_REPORT", `assertion ${decision.subject.id} is not in the run`);
    }
    const { evaluation, disposition, conditions, judgmentReview } = this.evaluateAssertion(
      scope,
      context,
      assertion,
      decision,
    );
    return {
      disposition,
      conditions,
      supportSet: evaluation.selected,
      qualifiersDigest: evaluation.qualifiersDigest,
      reviewRequired: reviewRequired || judgmentReview,
    };
  }

  /** The exact-use oracle (diagnostics); the native ingestion transaction calls the same admission module. */
  admitExactUse(
    scope: AuthScope,
    input: { decisionId: string; boundEffectDigest: Digest; processedEpoch: number; normalizedValuesDigest: Digest },
  ): Promise<AdmissionOutcome> {
    return this.binding.admitExactUse(scope, input);
  }

  private runRecord(context: RunContext): VerificationRun {
    if (context.run !== null) return context.run;
    throw new ResearchCoordinatorError("RUN_NOT_SEALED", "the run record is written at seal time");
  }
}

/** Missing evidence holds; only a contradiction or an L0 integrity failure on a required obligation rejects. */
function reportDisposition(aggregate: ReportAggregate): "admitted" | "held" | "rejected" {
  return aggregate.complete ? "admitted" : aggregate.rejectingRequired.length > 0 ? "rejected" : "held";
}

/** Decimal string addition for USD amounts (no floats in canonical bytes). */
export function addDecimal(a: string, b: string): string {
  const scale = Math.max(fraction(a), fraction(b));
  const toInt = (value: string) =>
    BigInt(value.replace(".", "").padEnd(value.replace(".", "").length + scale - fraction(value), "0"));
  const sum = toInt(a) + toInt(b);
  if (scale === 0) return sum.toString();
  const text = sum.toString().padStart(scale + 1, "0");
  const whole = text.slice(0, -scale);
  const frac = text.slice(-scale).replace(/0+$/, "");
  return frac.length === 0 ? whole : `${whole}.${frac}`;
}

function fraction(value: string): number {
  const index = value.indexOf(".");
  return index < 0 ? 0 : value.length - index - 1;
}

export { digestCanonical as researchDigest };
