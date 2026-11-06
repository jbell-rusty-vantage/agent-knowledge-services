import type {
  Digest,
  EvaluatorIdentity,
  JsonValue,
  OperationState,
  OperationStatus,
  Origin,
  ProtocolError,
  Ref,
  UnresolvedEffect,
} from "@aiengineer/knowledge-operation-protocol";
import type {
  Adjudication,
  AssertionOccurrence,
  AssertionVersion,
  AuthScope,
  CensusExplanation,
  CensusOutcome,
  CustodyStore,
  DiscoveredOccurrence,
  EvidenceFragment,
  ReportLedger,
  RenderedUnit,
  ReportAggregate,
  ReviewerScope,
  SourceDescription,
  ReportRevision,
  RunManifest,
  Seal,
  SealedRun,
  SupportSet,
  UnitExplanation,
  Usage,
  UseDecision,
  VerificationObservation,
  VerificationRun,
  VerificationTaskContract,
} from "@aiengineer/knowledge-research-core";

/**
 * The composite port the research coordinator (K04) drives. A binding (K05 PostgreSQL today, K06 Biotech through BKS
 * later) implements it over the common `knowledge_verification` component. Every write is tenant-scoped by the
 * binding's transaction discipline; the coordinator never sees SQL.
 */
export interface RunOpening {
  readonly task: Ref<"task">;
  readonly originatingOrigin: Origin;
  /** Stored once at opening; the sealed run record's `startedAt` is read back from it (deterministic seal retry). */
  readonly openedAt: string;
}

/** Everything the coordinator needs to aggregate, seal or decide one run; loaded as K02 records. */
export interface RunContext {
  readonly runId: string;
  readonly state: "preparing" | "observing" | "sealed" | "superseded";
  readonly openedAt: string;
  readonly head: Digest | null;
  readonly task: VerificationTaskContract;
  readonly report: { readonly revision: ReportRevision; readonly ledger: ReportLedger } | null;
  readonly assertions: readonly AssertionVersion[];
  readonly supportSets: readonly SupportSet[];
  readonly occurrences: readonly AssertionOccurrence[];
  readonly observations: readonly VerificationObservation[];
  readonly originatingOrigin: Origin;
  readonly missionCorrelation: { readonly missionId: string; readonly runId: string } | null;
  readonly operationId: string;
  /** The sealed run record (null until sealed): deterministic, written with the verification snapshot. */
  readonly run: VerificationRun | null;
  /**
   * The sealed lineage, oldest first, each verified on load (signature over the recomputed manifest digest and every
   * family digest): a binding refuses `SEAL_INVALID` / `FAMILY_TAMPERED` rather than return a tampered lineage.
   */
  readonly manifests: readonly SealedRun[];
}

/** A stored use decision with its supersession links (a successor names the decision it supersedes). */
export interface StoredDecision {
  readonly decision: UseDecision;
  readonly supersedes: string | null;
  readonly supersededBy: string | null;
}

export interface ReviewerGrantInput {
  readonly reviewerId: string;
  readonly scope: ReviewerScope;
  readonly grantedBy: string;
  readonly grantedAt: string;
}

/** An explicit source correction or revocation (design §7). A source is named by its capture artifact id. */
export interface CorrectionInput {
  readonly corrected: { readonly kind: "fragment" | "capture"; readonly id: string };
  readonly reason: string;
}

/** The recorded invalidation and its affected closure over the dependency edges (listed and closed in one step). */
export interface CorrectionClosure {
  readonly invalidationId: string;
  /** The new authoritative revocation epoch. */
  readonly epoch: number;
  readonly affected: readonly { readonly kind: string; readonly id: string }[];
  /** Fragments the correction invalidates (the corrected fragment, or every fragment of the corrected capture). */
  readonly fragments: readonly Ref<"fragment">[];
  /** Runs whose report revision is in the closure, with their state. */
  readonly runs: readonly { readonly runId: string; readonly state: RunContext["state"] }[];
}

export const REPORT_ASSESSMENT_SCHEMA_VERSION = "research-core.report_assessment.v1" as const;

/** One assessment of one frozen report revision under one run; immutable and content-addressed by its custody bytes. */
export interface ReportAssessmentRecord {
  readonly schemaVersion: typeof REPORT_ASSESSMENT_SCHEMA_VERSION;
  readonly id: string;
  readonly tenant: string;
  readonly binding: string;
  readonly report: Ref<"report">;
  readonly runId: string;
  readonly task: Ref<"task">;
  readonly kind: Ref<"report_kind">;
  readonly census:
    | { readonly status: "assessed"; readonly observation: Ref<"observation">; readonly holds: readonly string[] }
    | { readonly status: "stale"; readonly observation: Ref<"observation">; readonly reason: string }
    | { readonly status: "not_run" };
  readonly aggregate: ReportAggregate;
  readonly aggregateDigest: Digest;
  readonly outcome: "succeeded" | "partial" | "held" | "rejected";
  readonly assessedAt: string;
}

export interface AdmissionOutcome {
  readonly outcome: "admitted" | "held" | "rejected";
  readonly reason: string;
  readonly authoritativeEpoch: number;
}

export interface ResearchBinding {
  readonly binding: string;
  readonly custody: CustodyStore;
  freezeTask(scope: AuthScope, task: VerificationTaskContract): Promise<Ref<"task">>;
  openRun(scope: AuthScope, opening: RunOpening): Promise<string>;
  putFragment(scope: AuthScope, fragment: EvidenceFragment): Promise<Ref<"fragment">>;
  putAssertion(scope: AuthScope, assertion: AssertionVersion): Promise<Ref<"assertion">>;
  /** Exact assertion versions by ref (digest included); unknown refs are simply absent from the result. */
  loadAssertions(scope: AuthScope, refs: readonly Ref<"assertion">[]): Promise<readonly AssertionVersion[]>;
  putSupportSet(scope: AuthScope, set: SupportSet): Promise<Ref<"support_set">>;
  /**
   * W1 D19 preflight (read only): for each record, whether its id is held with other bytes or its bytes under another
   * id (the write-once rule the puts enforce), so a registration refuses before its first write.
   */
  recordCollisions(scope: AuthScope, records: readonly RecordProbe[]): Promise<readonly RecordCollision[]>;
  putReportRevision(
    scope: AuthScope,
    input: { runId: string; reportId: string; revision: number; record: ReportRevision; ledger: ReportLedger },
  ): Promise<Ref<"report">>;
  appendObservation(scope: AuthScope, runId: string, observation: VerificationObservation): Promise<Ref<"observation">>;
  loadRunContext(scope: AuthScope, runId: string): Promise<RunContext>;
  /**
   * Write the run record, the sealed manifest and the compare-and-set head in ONE transaction. An identical run record
   * already stored is accepted (retry); a different one refuses. Exactly one concurrent sealer wins.
   */
  seal(
    scope: AuthScope,
    input: { runId: string; run: VerificationRun; manifest: RunManifest; seal: Seal; expectedHead: Digest | null },
  ): Promise<SealedRun>;
  /** Durable `ReportAssessment` (design §3.2): references the frozen report, the run, its task and kind. */
  recordAssessment(
    scope: AuthScope,
    input: { record: ReportAssessmentRecord; artifact: Ref<"artifact">; operationId: string | null },
  ): Promise<Ref<"artifact">>;
  /** Record a decision; `supersedes` names the decision a successor (review, correction) replaces. */
  recordDecision(
    scope: AuthScope,
    decision: UseDecision,
    options?: { readonly supersedes?: string | null },
  ): Promise<Ref<"use_decision">>;
  loadDecision(scope: AuthScope, decisionId: string): Promise<StoredDecision | null>;
  /**
   * The exact-use oracle outside a native write (diagnostics, the MC review handoff). It delegates to the SAME
   * admission module the native ingestion transaction uses; it never authorizes a write by itself.
   */
  admitExactUse(
    scope: AuthScope,
    input: { decisionId: string; boundEffectDigest: Digest; processedEpoch: number; normalizedValuesDigest: Digest },
  ): Promise<AdmissionOutcome>;
  currentEpoch(scope: AuthScope): Promise<number>;
  /**
   * Side-effect-free current exact-use eligibility of one recorded decision (Sprint OC WI-03 `decision.resolve`): the
   * admission rule at the current authoritative epoch (stale epoch, invalidation, expiry, review binding with a live
   * grant), recording and locking nothing. The component function is `check_use_eligibility` (2.2.0).
   */
  checkUseEligibility(
    scope: AuthScope,
    input: { decisionId: string; boundEffectDigest: Digest },
  ): Promise<AdmissionOutcome>;
  /** Exact fragments by ref (digest included); unknown refs are absent from the result. */
  loadFragments(scope: AuthScope, refs: readonly Ref<"fragment">[]): Promise<readonly EvidenceFragment[]>;
  grantReviewer(scope: AuthScope, grant: ReviewerGrantInput): Promise<string>;
  revokeReviewerGrant(scope: AuthScope, input: { grantId: string; at: string }): Promise<void>;
  /** The store refuses `REVIEWER_NOT_QUALIFIED` without a live grant covering the decision's use/audience/kind. */
  recordAdjudication(scope: AuthScope, adjudication: Adjudication): Promise<Ref<"adjudication">>;
  loadAdjudication(scope: AuthScope, adjudicationId: string): Promise<Adjudication | null>;
  /**
   * Record the invalidation (authoritative epoch advance) and list its affected closure over the dependency edges in
   * ONE transaction: dependent decisions lose current-use eligibility immediately; unrelated branches are untouched.
   */
  recordCorrection(scope: AuthScope, input: CorrectionInput): Promise<CorrectionClosure>;
}

/** Verifies source authority for one fragment (verified origin family, design, applicability facts). Never guesses. */
export interface SourceAuthorityResolver {
  readonly evaluator: EvaluatorIdentity;
  readonly method: Ref<"method">;
  describe(scope: AuthScope, fragment: EvidenceFragment): Promise<SourceDescription>;
}

export type RevisionStatus = "current" | "corrected" | "retracted" | "withdrawn" | "unknown";

/** The revision frontier of a scholarly source (retractions, corrections), checked on demand; never a live feed. */
export interface RevisionFrontier {
  check(
    scope: AuthScope,
    doi: string,
  ): Promise<{ readonly status: RevisionStatus; readonly notices: readonly string[] }>;
}

/** Bounded counterevidence search (design §3.1 judgment 2: "what contrary evidence was found, what remains outside"). */
export interface CounterevidenceSearchResult {
  readonly status: "searched" | "not_searched";
  readonly reason?: string;
  readonly queries: readonly string[];
  readonly counterevidence: readonly EvidenceFragment[];
  readonly materialConflict: boolean;
  readonly frontier: {
    readonly exhausted: boolean;
    readonly searchedScopes: readonly string[];
    readonly limits: readonly string[];
    readonly unsearchedScopes: readonly string[];
  };
  readonly rationale: string;
  readonly usage: Usage;
}

export interface CounterevidenceSearch {
  readonly evaluator: EvaluatorIdentity;
  readonly method: Ref<"method">;
  search(
    scope: AuthScope,
    input: {
      readonly task: VerificationTaskContract;
      readonly assertion: AssertionVersion;
      readonly maxQueries: number;
    },
  ): Promise<CounterevidenceSearchResult>;
}

/**
 * The independent auditor discovery pass of the final census (design §3.2). It receives the frozen task, the exact
 * frozen body bytes (loaded from custody and digest-verified by the coordinator), the deterministic structural units of
 * that body, independently supplied evidence and the comparison assertions. It never receives the producer ledger.
 * Implementations may call a model; the coordinator records the result as one `auditor` census observation.
 */
export interface DiscoveryInput {
  readonly task: VerificationTaskContract;
  readonly report: Ref<"report">;
  readonly body: { readonly ref: Ref<"artifact">; readonly bytes: Uint8Array; readonly text: string };
  /** Renderer units (paths and spans) of the frozen body: structure, not producer claims. */
  readonly units: readonly RenderedUnit[];
  readonly evidence: readonly EvidenceFragment[];
  /** Assertions the auditor may map a discovered span to (design: producer assertions as a comparison input). */
  readonly assertions: readonly AssertionVersion[];
}

export interface DiscoveryResult {
  readonly evaluator: EvaluatorIdentity;
  readonly method: Ref<"method">;
  readonly occurrences: readonly DiscoveredOccurrence[];
  /** Explanations of named differences, by auditor occurrence id (or a producer id the auditor was shown). */
  readonly explanations: readonly CensusExplanation[];
  readonly unitExplanations: readonly UnitExplanation[];
  readonly recall: CensusOutcome["recall"];
  readonly rationale: string;
  readonly limitations: readonly string[];
  readonly usage: Usage;
  readonly rawResponse: Ref<"artifact"> | null;
}

export interface AuditorDiscovery {
  discover(scope: AuthScope, input: DiscoveryInput): Promise<DiscoveryResult>;
}

/**
 * Durable asynchronous operation records (component table `knowledge_verification.operation`, 0004). One row per
 * operation: K01 status fields, monotonic revision, compare-and-set transitions, idempotent start by request id and
 * idempotent cancellation by cancel request id. Transport-free: SV-16 exposes it over HTTP/MCP.
 */
export interface OperationRecord {
  readonly status: OperationStatus;
  readonly operation: string;
  readonly requestId: string;
  readonly requestDigest: Digest;
  readonly request: JsonValue;
  readonly runId: string | null;
  readonly subject: Ref | null;
}

export interface OperationStart {
  readonly operationId: string;
  readonly operation: string;
  readonly requestId: string;
  readonly request: JsonValue;
  readonly requestDigest: Digest;
  readonly runId: string | null;
  readonly subject: Ref | null;
  readonly retryAfterMs: number;
  readonly at: string;
}

export interface OperationTransition {
  readonly operationId: string;
  /** Compare-and-set: the revision the caller last observed. A concurrent writer makes this `REVISION_MISMATCH`. */
  readonly expectedRevision: number;
  readonly to: OperationState;
  readonly at: string;
  readonly progressRef?: Ref<"artifact"> | null;
  readonly pendingReviewRef?: Ref<"adjudication"> | null;
  readonly resultRef?: Ref | null;
  readonly error?: ProtocolError | null;
  readonly unresolvedEffects?: readonly UnresolvedEffect[];
  readonly retryAfterMs?: number;
}

export class OperationStoreError extends Error {
  readonly code: "OPERATION_NOT_FOUND" | "REVISION_MISMATCH" | "ILLEGAL_TRANSITION" | "REQUEST_CONFLICT";
  constructor(code: OperationStoreError["code"], message?: string) {
    super(message ? `${code}: ${message}` : code);
    this.name = "OperationStoreError";
    this.code = code;
  }
}

export interface OperationStore {
  /** Idempotent by (operation, request id): the same request returns the existing record; a different one conflicts. */
  start(scope: AuthScope, input: OperationStart): Promise<OperationRecord>;
  get(scope: AuthScope, operationId: string): Promise<OperationRecord | null>;
  transition(scope: AuthScope, input: OperationTransition): Promise<OperationRecord>;
  /** Idempotent: the first cancel request id wins; repeats and cancels of terminal operations change nothing. */
  cancel(
    scope: AuthScope,
    input: { operationId: string; cancelRequestId: string; at: string },
  ): Promise<OperationRecord>;
}

/** One registration record a preflight probes (W1 D19). */
export interface RecordProbe {
  readonly kind: "task" | "fragment" | "assertion" | "support_set";
  readonly id: string;
  readonly digest: string;
}

/** A record id held with other bytes, or these bytes held under another id (`id` names the stored one). */
export interface RecordCollision {
  readonly reason: "record_id_conflict" | "record_digest_exists";
  readonly record: RecordProbe["kind"];
  readonly id: string;
}
