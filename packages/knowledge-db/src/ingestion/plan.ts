import { proposalClaims, admissionIssues, type AuthoritativeClaim, type ReportEvidence } from "./evidence-admission.js";
import { canonicalJson, digestOf, sha256Hex, type Digest } from "../db-read/index.js";
import {
  subjectRefsOf,
  type IngestionIntent,
  type NewSubject,
  type Proposal,
  type ProposalKind,
  type ProposalOf,
  type Subject,
} from "./intent.js";
import { claimPlaceholder, subjectPlaceholder, subjectRefOfPlaceholder } from "./placeholders.js";
import {
  applyRules,
  type RuleCheck,
  type RuleFacts,
  type RuleSet,
  type Rewrite,
  type RuleApplication,
} from "./rules.js";
import { validateProposal, type VocabularyIssue } from "./validate.js";
import type { Vocabulary } from "./vocabulary.js";
import { normalizeTemporalUnit, eventExtent } from "./temporal.js";
import {
  type Digest as K01Digest,
  type JsonValue as K01JsonValue,
  boundEffectDigest as k01BoundEffectDigest,
  canonicalJson as k01CanonicalJson,
  digestBytes as k01DigestBytes,
} from "@aiengineer/knowledge-operation-protocol";

/** `knowledge-ingestion-plan.v1` and the pure planner that produces it from gathered facts. */

export type ProposalOutcome =
  | "admitted"
  | "no_op_duplicate"
  | "superseded"
  | "review_required"
  | "held"
  | "quarantined"
  | "rejected";
export type PlannedOutcome = "applied" | "noop" | "partial" | "rejected";

export interface EntityMatch {
  readonly entityId: string;
  readonly kind: string;
  readonly displayName: string;
  readonly score: number;
  readonly basis: "identifier" | "alias" | "name";
}
export interface SubjectFacts {
  readonly ref: string;
  readonly lifecycle?: "active" | "merged" | "retired" | "missing";
  readonly kind?: string;
  readonly mergedInto?: string | null;
  readonly matches?: readonly EntityMatch[];
  readonly slugTaken?: boolean;
}
/** Keyed by proposalId: what the current head already holds for each proposal's slot. */
export interface ExistingFacts {
  readonly segments: Readonly<Record<string, { segmentId: string; kFrom: number }>>;
  readonly relationships: Readonly<Record<string, { relationshipId: string; sameProperties: boolean }>>;
  readonly occurrences: Readonly<Record<string, { occurrenceId: string }>>;
  /** `scope_key` of the subject's current series with the proposal's stream kind and unit, when one exists. */
  readonly seriesKeys: Readonly<Record<string, string>>;
  readonly records?: Readonly<Record<string, { recordId: string }>>;
}
export interface ClaimFacts {
  readonly authoritative?: AuthoritativeClaim;
  readonly fixtureOnly?: boolean;
  readonly runId: string;
  readonly claimId: string;
  readonly sealed: boolean;
  readonly eligible: boolean;
  readonly verdict?: string;
  readonly claimRowId: string | null;
}
export interface ChangedItem {
  readonly subjectRef: string;
  readonly entityId: string;
  readonly itemKind: "segment" | "event" | "relationship";
  readonly itemId: string;
  readonly knowledgeSeq: number;
  readonly streamKind?: string;
  readonly scopeKey?: string;
  readonly relationshipKind?: string;
  readonly eventKind?: string;
}

export interface PlanFacts {
  readonly reports?: Readonly<Record<string, ReportEvidence>>;
  readonly currentHead: number;
  readonly vocabulary: Vocabulary;
  readonly subjects: Readonly<Record<string, SubjectFacts>>;
  readonly existing: ExistingFacts;
  readonly claims: readonly ClaimFacts[];
  readonly whatChanged: readonly ChangedItem[];
  readonly rules: RuleSet;
}

export interface PlanExecutorIdentity {
  readonly version: string;
  readonly migrationHead: string;
}

export interface PlannedSubject {
  readonly ref: string;
  readonly resolution: "resolved" | "create" | "use_existing" | "review" | "merged" | "missing";
  readonly kind: string;
  readonly entityId: string | null;
  readonly lifecycle?: string;
  readonly mergedInto?: string | null;
  readonly matches: readonly EntityMatch[];
  readonly slug?: string;
}

export interface PlannedAction {
  readonly fn?: string;
  readonly table?: string;
  readonly op?: string;
  readonly args: Record<string, unknown>;
}

export interface PlannedProposal {
  readonly proposalId: string;
  readonly ordinal: number;
  readonly kind: ProposalKind;
  readonly outcome: ProposalOutcome;
  readonly idempotencyKey: Digest;
  readonly effective: Proposal;
  readonly synthesized?: boolean;
  readonly reason?: string;
  readonly rewrites: readonly Rewrite[];
  readonly existing?: Record<string, unknown>;
  readonly actions: readonly PlannedAction[];
}

export interface PlanError {
  readonly code: string;
  readonly message: string;
  readonly proposalId?: string;
  readonly details?: unknown;
}

export const NATIVE_EFFECT_SCHEMA_VERSION = "knowledge-ingestion-effect.v1" as const;

export interface PlannedEffect {
  readonly schemaVersion: typeof NATIVE_EFFECT_SCHEMA_VERSION;
  readonly effectKey: string;
  readonly semanticPayloadDigest: K01Digest;
  readonly boundEffectDigest: K01Digest;
}

/**
 * The exact native bytes an exact-use decision binds: tenant, intent id, the planned subject resolutions and the
 * planned proposals (id, kind, outcome and effective proposal after rules) in plan order. K01 canonical JSON.
 */
export function nativeEffectPayload(
  intent: IngestionIntent,
  subjects: readonly PlannedSubject[],
  proposals: readonly PlannedProposal[],
): string {
  return k01CanonicalJson(
    canonicalNumbers({
      schemaVersion: NATIVE_EFFECT_SCHEMA_VERSION,
      tenantId: intent.context.tenantId,
      intentId: intent.intentId,
      subjects: subjects.map((subject) => ({
        ref: subject.ref,
        resolution: subject.resolution,
        kind: subject.kind,
        entityId: subject.entityId,
      })),
      proposals: proposals.map((proposal) => ({
        proposalId: proposal.proposalId,
        kind: proposal.kind,
        outcome: proposal.outcome,
        effective: proposal.effective,
      })),
    }) as K01JsonValue,
  );
}

/**
 * K01 canonical bytes carry safe integers only; a non-integer (or unsafe) number in a proposal is bound as the string
 * `decimal:<shortest round-trip form>` so the digest is deterministic without floats in canonical bytes.
 */
function canonicalNumbers(value: unknown): unknown {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : `decimal:${String(value)}`;
  if (Array.isArray(value)) return value.map(canonicalNumbers);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, item]) => (item === undefined ? [] : [[key, canonicalNumbers(item)]])),
    );
  }
  return value;
}

function plannedEffect(
  intent: IngestionIntent,
  subjects: readonly PlannedSubject[],
  proposals: readonly PlannedProposal[],
): PlannedEffect | null {
  if (intent.exactUse === undefined) return null;
  const payload = nativeEffectPayload(intent, subjects, proposals);
  return {
    schemaVersion: NATIVE_EFFECT_SCHEMA_VERSION,
    effectKey: intent.exactUse.effectKey,
    semanticPayloadDigest: k01DigestBytes(payload),
    boundEffectDigest: k01BoundEffectDigest(payload, intent.exactUse.originatingOrigin),
  };
}

export interface IngestionPlan {
  readonly schemaVersion: "knowledge-ingestion-plan.v1";
  readonly planId: string;
  readonly intentRef: {
    readonly intentId: string;
    readonly intentDigest: Digest;
    readonly idempotencyKey: Digest;
    readonly artifactId?: string;
  };
  readonly executor: {
    readonly version: string;
    readonly rulesVersion: string;
    readonly migrationHead: string;
  };
  readonly rules: {
    readonly loaded: boolean;
    readonly count: number;
    readonly note?: string;
  };
  readonly head: {
    readonly snapshot: number | null;
    readonly current: number;
    readonly stale: boolean;
    readonly rebased: boolean;
    readonly effectiveExpectedHead: number | null;
    readonly whatChanged: readonly ChangedItem[];
    readonly touchedBy: readonly string[];
  };
  readonly evidence: {
    readonly runs: readonly { runId: string; sealed: boolean }[];
    readonly claims: readonly ClaimFacts[];
  };
  readonly subjects: readonly PlannedSubject[];
  readonly proposals: readonly PlannedProposal[];
  readonly ruleChecks: readonly RuleCheck[];
  readonly plannedOutcome: PlannedOutcome;
  readonly plannedSummary: Readonly<Record<ProposalOutcome, number>>;
  readonly order: readonly string[];
  readonly errors: readonly PlanError[];
  /**
   * SV-08: the exact native effect of this plan when the intent carries an exact-use binding. `boundEffectDigest` is
   * the K01 bound effect digest of the planned proposal bytes (`nativePayload`) and the originating origin; the
   * intent's `exactUse.boundEffectDigest` must equal it, otherwise the apply refuses EFFECT_CONFLICT.
   */
  readonly effect: PlannedEffect | null;
}

const GROUP_ORDER: readonly ProposalKind[] = [
  "claim.materialize",
  "candidate.stage",
  "entity.create",
  "entity.alias",
  "entity.identifier",
  "relationship.assert",
  "fact.assert_state",
  "event.assert",
  "support.admit",
  "metric.observe",
  "record.materialize",
  "report.publish",
];
/** A resolve/identifier score at or above this turns `entity.create` into review (or `use_existing`). */
export const STRONG_MATCH = 0.98;
const MAX_SLUG_LENGTH = 80;
const FALLBACK_SLUG = "entity";
const SLUG_DISAMBIGUATOR_HEX_CHARS = 6;
/** RFC 9562 layout: 128 bits of hex with the version nibble forced to 8 and the variant bits to 10xx. */
const UUID_HEX_CHARS = 32;
const UUID_VERSION_8 = "8";
const UUID_VARIANT_MASK = 0x3;
const UUID_VARIANT_BITS = 0x8;
const NULL_SEPARATOR = "\0";

export const intentDigestOf = (intent: IngestionIntent): Digest => digestOf(withoutVolatile(intent));
export const intentIdempotencyKey = (intent: IngestionIntent, rulesVersion: string): Digest =>
  digestOf({
    tenantId: intent.context.tenantId,
    intentId: intent.intentId,
    proposals: intent.proposals,
    subjects: intent.subjects,
    inputSnapshotDigest: intent.inputSnapshot?.snapshotDigest ?? null,
    rulesVersion,
  });
export const proposalIdempotencyKey = (intent: IngestionIntent, ordinal: number, proposal: Proposal): Digest =>
  digestOf({
    tenantId: intent.context.tenantId,
    intentId: intent.intentId,
    ordinal,
    proposal,
  });

function withoutVolatile(intent: IngestionIntent): Omit<IngestionIntent, "idempotencyKey" | "notes"> {
  const { idempotencyKey: _key, notes: _notes, ...rest } = intent;
  return rest;
}

/**
 * The plan's identity input: the intent digest without the exact-use DECISION fields (`useDecisionId`,
 * `boundEffectDigest`, `processedEpoch`, `normalizedValuesDigest`) and effect dispatch key. The decision binds the plan's effect, so the plan id
 * cannot depend on it: `knowledge.plan_preview` (no decision yet) and the later `knowledge.apply` (with the decision)
 * name the same plan in the same database state. The preview key may differ from the final decision-derived dispatch
 * key; neither is part of the native semantic payload. The originating origin stays in. The full intent digest still
 * binds the dispatch key for duplicate/conflict checks. An intent without
 * `exactUse` keeps exactly its intent digest (unchanged plan ids).
 */
export function planIdentityDigest(intent: IngestionIntent): Digest {
  if (intent.exactUse === undefined) return intentDigestOf(intent);
  const {
    effectKey: _effectKey,
    useDecisionId: _decision,
    boundEffectDigest: _bound,
    processedEpoch: _epoch,
    normalizedValuesDigest: _values,
    ...effect
  } = intent.exactUse;
  return digestOf({ ...withoutVolatile(intent), exactUse: effect });
}

/** Deterministic, RFC 9562 version-8 formatted identifier derived from a namespace and value. */
export function deterministicId(namespace: string, value: string): string {
  const hex = sha256Hex(`${namespace}${NULL_SEPARATOR}${value}`).slice(0, UUID_HEX_CHARS);
  const variantNibble = ((Number.parseInt(hex[16]!, 16) & UUID_VARIANT_MASK) | UUID_VARIANT_BITS).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${UUID_VERSION_8}${hex.slice(13, 16)}-${variantNibble}${hex.slice(17, 20)}-${hex.slice(20)}`;
}

export const slugify = (text: string): string =>
  text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH) || FALLBACK_SLUG;

export function buildPlan(intent: IngestionIntent, facts: PlanFacts, executor: PlanExecutorIdentity): IngestionPlan {
  const builder = new PlanBuilder(intent, facts);
  const intentDigest = intentDigestOf(intent);
  const idempotencyKey = intentIdempotencyKey(intent, facts.rules.rulesVersion);
  const subjects = builder.planSubjects();
  const head = builder.planHead();
  const proposals = builder.planProposals(subjects);
  const ruleChecks = proposals.flatMap((planned) => planned.ruleChecks);
  const plannedProposals = builder.closeDependencies(proposals.map(({ ruleChecks: _checks, ...planned }) => planned));
  const order = builder.orderProposals(plannedProposals);
  const plannedOutcome = plannedOutcomeOf(builder.errors, plannedProposals);
  return {
    schemaVersion: "knowledge-ingestion-plan.v1",
    planId: deterministicId(
      "knowledge-ingestion-plan",
      canonicalJson({
        intentDigest: planIdentityDigest(intent),
        head: facts.currentHead,
        rules: facts.rules.rulesVersion,
        executor: executor.version,
      }),
    ),
    intentRef: { intentId: intent.intentId, intentDigest, idempotencyKey },
    executor: {
      version: executor.version,
      rulesVersion: facts.rules.rulesVersion,
      migrationHead: executor.migrationHead,
    },
    rules: {
      loaded: facts.rules.loaded,
      count: facts.rules.rules.length,
      ...(facts.rules.note ? { note: facts.rules.note } : {}),
    },
    head,
    evidence: {
      runs: intent.evidence.verificationRuns.map((run) => ({
        runId: run.runId,
        sealed: facts.claims.some((claim) => claim.runId === run.runId && claim.sealed),
      })),
      claims: facts.claims,
    },
    subjects,
    proposals: plannedProposals,
    ruleChecks,
    plannedOutcome,
    plannedSummary: summarize(plannedProposals),
    effect: plannedEffect(intent, subjects, plannedProposals),
    order,
    errors: builder.errors,
  };
}

/** Computed before `orderProposals`, so a `dependsOn` cycle is reported in `errors` without changing the outcome. */
function plannedOutcomeOf(errors: readonly PlanError[], proposals: readonly PlannedProposal[]): PlannedOutcome {
  if (errors.length > 0) return "rejected";
  if (proposals.every((item) => item.outcome === "no_op_duplicate")) return "noop";
  if (proposals.every((item) => item.outcome === "admitted" || item.outcome === "no_op_duplicate")) return "applied";
  return "partial";
}

interface PlannedWithChecks extends PlannedProposal {
  readonly ruleChecks: readonly RuleCheck[];
}
interface ProposalCandidate {
  readonly proposal: Proposal;
  readonly ordinal: number;
  readonly synthesized: boolean;
}
interface ProposalScope {
  readonly bySubject: ReadonlyMap<string, PlannedSubject>;
  readonly allIds: ReadonlySet<string>;
}
type OutcomeSlice = Pick<PlannedProposal, "outcome" | "actions"> &
  Partial<Pick<PlannedProposal, "reason" | "existing">>;

const isNewSubject = (subject: Subject): subject is NewSubject => subject.mode === "new";
const isEntityCreate = (proposal: Proposal): proposal is ProposalOf<"entity.create"> =>
  proposal.kind === "entity.create";
const ruleWithResult = (checks: readonly RuleCheck[], result: RuleCheck["result"]): string | undefined =>
  checks.find((check) => check.result === result)?.rule;

/** Plans one intent against one set of facts; every phase records its errors here in encounter order. */
class PlanBuilder {
  readonly errors: PlanError[] = [];

  constructor(
    private readonly intent: IngestionIntent,
    private readonly facts: PlanFacts,
  ) {}

  planSubjects(): PlannedSubject[] {
    return this.intent.subjects.map((subject) => {
      const known = this.facts.subjects[subject.ref] ?? { ref: subject.ref };
      if (!this.facts.vocabulary.entityKinds.has(subject.kind))
        this.fail({
          code: "VOCABULARY_VIOLATION",
          message: `subject ${subject.ref}: unknown entity kind ${subject.kind}`,
          details: { allowed: [...this.facts.vocabulary.entityKinds.keys()] },
        });
      return isNewSubject(subject) ? this.planNewSubject(subject, known) : this.planResolvedSubject(subject, known);
    });
  }

  private planResolvedSubject(subject: Extract<Subject, { mode: "resolved" }>, known: SubjectFacts): PlannedSubject {
    if (known.lifecycle === "merged")
      this.fail({
        code: "SUBJECT_MERGED",
        message: `subject ${subject.ref} was merged`,
        details: { mergedInto: known.mergedInto },
      });
    else if (known.lifecycle !== "active")
      this.fail({
        code: "SUBJECT_UNKNOWN",
        message: `subject ${subject.ref} (${subject.entityId}) is not an active entity at the current head`,
      });
    const resolution = known.lifecycle === "merged" ? "merged" : known.lifecycle === "active" ? "resolved" : "missing";
    return {
      ref: subject.ref,
      resolution,
      kind: subject.kind,
      entityId: subject.entityId,
      ...(known.lifecycle ? { lifecycle: known.lifecycle } : {}),
      ...(known.mergedInto !== undefined ? { mergedInto: known.mergedInto } : {}),
      matches: [],
    };
  }

  private planNewSubject(subject: NewSubject, known: SubjectFacts): PlannedSubject {
    const matches = known.matches ?? [];
    const strong = matches.find((match) => match.score >= STRONG_MATCH);
    if (strong && strong.kind !== subject.kind)
      this.fail({
        code: "VOCABULARY_VIOLATION",
        message: `subject ${subject.ref}: matched ${strong.kind} cannot be reused as ${subject.kind}`,
        details: { entityId: strong.entityId },
      });
    const kind = this.facts.vocabulary.entityKinds.get(subject.kind);
    const unknownColumns = kind
      ? Object.keys(subject.typedPayload).filter((column) => !kind.columns.includes(column))
      : [];
    if (unknownColumns.length > 0)
      this.fail({
        code: "VOCABULARY_VIOLATION",
        message: `subject ${subject.ref}: typedPayload keys are not columns of ${kind?.schema}.${kind?.table}`,
        details: { unknownColumns, allowed: kind?.columns },
      });
    const slug = this.subjectSlug(subject, known);
    if (strong && subject.onMatch === "fail")
      this.fail({
        code: "SUBJECT_MATCH_EXISTS",
        message: `subject ${subject.ref} matches existing entity ${strong.entityId}`,
        details: strong,
      });
    if (strong && subject.onMatch === "use_existing")
      return {
        ref: subject.ref,
        resolution: "use_existing",
        kind: subject.kind,
        entityId: strong.entityId,
        matches,
        slug,
      };
    if (strong)
      return {
        ref: subject.ref,
        resolution: "review",
        kind: subject.kind,
        entityId: null,
        matches,
        slug,
      };
    const entityId = deterministicId(
      "corpus.entity",
      [this.intent.context.tenantId, this.intent.intentId, subject.ref].join(NULL_SEPARATOR),
    );
    return {
      ref: subject.ref,
      resolution: "create",
      kind: subject.kind,
      entityId,
      matches,
      slug,
    };
  }

  private subjectSlug(subject: NewSubject, known: SubjectFacts): string {
    const baseSlug = slugify(subject.displayName);
    if (!known.slugTaken) return baseSlug;
    return `${baseSlug}-${sha256Hex(`${this.intent.intentId}${NULL_SEPARATOR}${subject.ref}`).slice(0, SLUG_DISAMBIGUATOR_HEX_CHARS)}`;
  }

  planHead(): IngestionPlan["head"] {
    const { intent, facts } = this;
    const snapshot = intent.expectedKnowledgeHead ?? intent.inputSnapshot?.knowledgeSeq ?? null;
    const stale = snapshot !== null && snapshot !== facts.currentHead;
    if (!stale)
      return {
        snapshot,
        current: facts.currentHead,
        stale: false,
        rebased: false,
        effectiveExpectedHead: snapshot,
        whatChanged: [],
        touchedBy: [],
      };
    const effectiveIntent = {
      ...intent,
      proposals: intent.proposals.map(
        (proposal) =>
          applyRules(facts.rules, normalizeTemporalUnit(proposal, facts.vocabulary), this.ruleFacts(proposal)).proposal,
      ),
    };
    const touchedBy =
      intent.onStale === "rebase_if_disjoint"
        ? touchedProposals(effectiveIntent, facts.whatChanged)
        : intent.proposals.map((proposal) => proposal.proposalId);
    if (touchedBy.length === 0)
      return {
        snapshot,
        current: facts.currentHead,
        stale: true,
        rebased: true,
        effectiveExpectedHead: facts.currentHead,
        whatChanged: facts.whatChanged,
        touchedBy,
      };
    this.fail({
      code: "REBASE_REQUIRED",
      message: `knowledge head advanced ${snapshot}→${facts.currentHead} and ${touchedBy.length} proposal(s) touch changed slots (onStale=${intent.onStale})`,
      details: { whatChanged: facts.whatChanged, touchedBy },
    });
    return {
      snapshot,
      current: facts.currentHead,
      stale: true,
      rebased: false,
      effectiveExpectedHead: snapshot,
      whatChanged: facts.whatChanged,
      touchedBy,
    };
  }

  /** Explicit proposals first, then a synthesized `entity.create` for every new subject without one. */
  planProposals(subjects: readonly PlannedSubject[]): PlannedWithChecks[] {
    const explicitCreates = new Set(
      this.intent.proposals.filter(isEntityCreate).map((proposal) => proposal.subjectRef),
    );
    const synthesized: Proposal[] = this.intent.subjects
      .filter(isNewSubject)
      .filter((subject) => !explicitCreates.has(subject.ref))
      .map((subject) => ({
        proposalId: `create-${subject.ref}`,
        kind: "entity.create",
        subjectRef: subject.ref,
        belief: "accepted",
        evidence: subject.evidence,
        dependsOn: [],
      }));
    const all = [...this.intent.proposals, ...synthesized];
    const scope: ProposalScope = {
      bySubject: new Map(subjects.map((subject) => [subject.ref, subject])),
      allIds: this.uniqueProposalIds(all),
    };
    return all.map((proposal, ordinal) =>
      this.planProposal(
        {
          proposal,
          ordinal,
          synthesized: ordinal >= this.intent.proposals.length,
        },
        scope,
      ),
    );
  }

  private uniqueProposalIds(proposals: readonly Proposal[]): ReadonlySet<string> {
    const ids = new Set<string>();
    for (const proposal of proposals) {
      if (ids.has(proposal.proposalId))
        this.fail({
          code: "INTENT_SCHEMA_INVALID",
          message: `duplicate proposalId ${proposal.proposalId}`,
          proposalId: proposal.proposalId,
        });
      ids.add(proposal.proposalId);
    }
    return ids;
  }

  private planProposal(candidate: ProposalCandidate, scope: ProposalScope): PlannedWithChecks {
    const { proposal, ordinal } = candidate;
    const normalized = normalizeTemporalUnit(proposal, this.facts.vocabulary);
    const ruling = applyRules(this.facts.rules, normalized, this.ruleFacts(proposal));
    const unitRewrites: Rewrite[] =
      normalized !== proposal && normalized.kind === "fact.assert_state" && proposal.kind === "fact.assert_state"
        ? [
            {
              rule: "temporal.unit_spelling",
              field: "unit",
              from: proposal.unit,
              to: normalized.unit,
            },
          ]
        : [];
    const effective = ruling.proposal;
    const base = {
      proposalId: proposal.proposalId,
      ordinal,
      kind: proposal.kind,
      idempotencyKey: proposalIdempotencyKey(this.intent, ordinal, proposal),
      effective,
      rewrites: [...unitRewrites, ...ruling.rewrites],
      ruleChecks: ruling.checks,
      ...(candidate.synthesized ? { synthesized: true } : {}),
    };
    if (proposal.kind === "report.publish") {
      this.fail({
        code: "LEGACY_REPORT_PUBLISH_UNSUPPORTED",
        message:
          "Register a research-report/v2 revision (report.register) and assess it before any separate graph apply",
        proposalId: proposal.proposalId,
      });
      return {
        ...base,
        outcome: "rejected",
        reason: "LEGACY_REPORT_PUBLISH_UNSUPPORTED",
        actions: [],
      };
    }
    this.checkReferences(effective, scope);
    const verdict = this.rulingOutcome(effective, ruling);
    if (verdict) return { ...base, ...verdict };
    const reviewSubject = subjectRefsOf(effective)
      .map((ref) => scope.bySubject.get(ref))
      .find((subject) => subject?.resolution === "review");
    if (reviewSubject && effective.kind === "entity.create")
      return {
        ...base,
        outcome: "review_required",
        reason: "identity_ambiguous",
        actions: [
          {
            table: "staging.candidate",
            op: "insert",
            args: { matches: reviewSubject.matches },
          },
        ],
      };
    if (reviewSubject)
      return {
        ...base,
        outcome: "held",
        reason: `subject_review_required:${reviewSubject.ref}`,
        actions: [],
      };
    return { ...base, ...this.admissionOutcome(effective, scope) };
  }

  private ruleFacts(proposal: Proposal): RuleFacts {
    const existingSeriesKey = this.facts.existing.seriesKeys[proposal.proposalId];
    return existingSeriesKey === undefined ? {} : { existingSeriesKey };
  }

  /** Subject refs, `dependsOn`, vocabulary, and evidence eligibility; each problem becomes a plan error. */
  private checkReferences(proposal: Proposal, scope: ProposalScope): void {
    for (const ref of subjectRefsOf(proposal))
      if (!scope.bySubject.has(ref))
        this.fail({
          code: "SUBJECT_UNKNOWN",
          message: `${proposal.proposalId}: subjectRef ${ref} is not declared in subjects[]`,
          proposalId: proposal.proposalId,
        });
    for (const dependency of proposal.dependsOn)
      if (!scope.allIds.has(dependency))
        this.fail({
          code: "INTENT_SCHEMA_INVALID",
          message: `${proposal.proposalId}: dependsOn ${dependency} is not a proposal`,
          proposalId: proposal.proposalId,
        });
    const issues = [
      ...validateProposal(proposal, {
        vocabulary: this.facts.vocabulary,
        subjects: scope.bySubject,
      }),
      ...this.evidenceIssues(proposal),
    ];
    for (const issue of issues) this.fail({ ...issue, proposalId: proposal.proposalId });
  }

  private evidenceIssues(proposal: Proposal): VocabularyIssue[] {
    return admissionIssues({
      intent: this.intent,
      proposal,
      facts: this.facts,
    });
  }

  private claimFact(runId: string, claimId: string): ClaimFacts | undefined {
    return this.facts.claims.find((claim) => claim.runId === runId && claim.claimId === claimId);
  }

  /** A rule verdict other than `admit` decides the proposal before admission comparison. */
  private rulingOutcome(proposal: Proposal, ruling: RuleApplication): OutcomeSlice | undefined {
    switch (ruling.verdict) {
      case "reject":
        this.fail({
          code: "RULE_VIOLATION",
          message: `${proposal.proposalId}: rejected by rule ${ruleWithResult(ruling.checks, "reject")}`,
          proposalId: proposal.proposalId,
        });
        return { outcome: "rejected", reason: "rule", actions: [] };
      case "hold":
        return {
          outcome: "held",
          reason: `rule:${ruleWithResult(ruling.checks, "hold")}`,
          actions: [],
        };
      case "stage":
        return {
          outcome: "review_required",
          reason: `rule:${ruleWithResult(ruling.checks, "stage")}`,
          actions: [
            {
              table: "staging.candidate",
              op: "insert",
              args: { reason: "no_stream_kind" },
            },
          ],
        };
      case "admit":
        return undefined;
    }
  }

  /** Phase 6 admission comparison against the current head, per proposal kind. */
  private admissionOutcome(proposal: Proposal, scope: ProposalScope): OutcomeSlice {
    const subject = (ref: string): string => scope.bySubject.get(ref)?.entityId ?? subjectPlaceholder(ref);
    const claimArg = proposal.evidence[0]
      ? claimPlaceholder(proposal.evidence[0].runId, proposal.evidence[0].claimId)
      : null;
    const { existing } = this.facts;
    switch (proposal.kind) {
      case "entity.create":
        return entityCreateOutcome(scope.bySubject.get(proposal.subjectRef));
      case "entity.alias":
        return {
          outcome: "admitted",
          actions: [
            {
              table: "corpus.entity_alias",
              op: "insert_if_absent",
              args: {
                entity: subject(proposal.subjectRef),
                alias: proposal.alias,
                alias_kind: proposal.aliasKind,
              },
            },
          ],
        };
      case "entity.identifier":
        return {
          outcome: "admitted",
          actions: [
            {
              table: "corpus.entity_identifier",
              op: "insert_if_absent",
              args: {
                entity: subject(proposal.subjectRef),
                scheme: proposal.scheme,
                value: proposal.value,
              },
            },
          ],
        };
      case "relationship.assert": {
        const current = existing.relationships[proposal.proposalId];
        const temporal = this.facts.vocabulary.relationshipKinds.get(proposal.relationshipKind)?.temporal ?? false;
        if (current && current.sameProperties && !temporal)
          return {
            outcome: "no_op_duplicate",
            existing: { relationshipId: current.relationshipId },
            actions: [],
          };
        return {
          outcome: "admitted",
          actions: [
            {
              fn: "temporal.assert_relationship",
              args: {
                kind: proposal.relationshipKind,
                from: subject(proposal.fromRef),
                to: subject(proposal.toRef),
                valid_during: proposal.worldInterval ?? null,
                qualifier: proposal.qualifier,
                episode: proposal.episode,
                claim: claimArg,
              },
            },
          ],
        };
      }
      case "fact.assert_state": {
        const current = existing.segments[proposal.proposalId];
        if (current)
          return {
            outcome: "no_op_duplicate",
            existing: { segmentId: current.segmentId, k_from: current.kFrom },
            actions: [],
          };
        const extentActions: PlannedAction[] = proposal.extent
          ? [
              {
                fn: "temporal.make_extent",
                args: {
                  source_text: proposal.extent.sourceText,
                  precision: proposal.extent.precision,
                },
              },
            ]
          : [];
        return {
          outcome: "admitted",
          actions: [
            ...extentActions,
            {
              fn: "temporal.assert_state",
              args: {
                stream_kind: proposal.streamKind,
                scope_key: proposal.scopeKey ?? "",
                subject: proposal.subjectRef ? subject(proposal.subjectRef) : null,
                relationship: proposal.relationshipRef ?? null,
                valid_during: proposal.worldInterval,
                status: proposal.status ?? null,
                amount: proposal.amount ?? null,
                currency: proposal.currency ?? null,
                unit: proposal.unit ?? null,
                temporal_basis: proposal.temporalBasis,
                belief: proposal.belief,
                claim: claimArg,
              },
            },
          ],
        };
      }
      case "event.assert": {
        const current = existing.occurrences[proposal.proposalId];
        if (current)
          return {
            outcome: "no_op_duplicate",
            existing: { occurrenceId: current.occurrenceId },
            actions: [],
          };
        return {
          outcome: "admitted",
          actions: [
            { fn: "temporal.make_extent", args: { ...eventExtent(proposal) } },
            {
              fn: "temporal.assert_event",
              args: {
                event_kind: proposal.eventKind,
                subject: subject(proposal.subjectRef),
                object: proposal.objectRef ? subject(proposal.objectRef) : null,
                occurred_during: proposal.occurredDuring,
                mode: proposal.occurrenceKind,
                claim: claimArg,
              },
            },
          ],
        };
      }
      case "support.admit":
        return this.supportOutcome(proposal, claimArg);
      case "claim.materialize":
        return this.materializeOutcome(proposal);
      case "record.materialize": {
        const current = existing.records?.[proposal.proposalId];
        if (current) return { outcome: "no_op_duplicate", existing: current, actions: [] };
        return {
          outcome: "admitted",
          actions: [
            "knowledge.record",
            "knowledge.compatibility_constraint",
            "evidence.claim_record",
            "knowledge.record_entity_link",
          ].map((table) => ({
            table,
            op: "insert",
            args: { subject: subject(proposal.subjectRef), claim: claimArg },
          })),
        };
      }
      case "metric.observe":
        return {
          outcome: "admitted",
          actions: [
            {
              table: "ranking.metric_observation",
              op: "insert",
              args: {
                subject: subject(proposal.subjectRef),
                metric_definition_version_id: proposal.metricDefinitionVersionId,
                value: proposal.value,
                observed_at: proposal.observedAt,
                claim: claimArg,
              },
            },
          ],
        };
      case "candidate.stage":
        return {
          outcome: "review_required",
          reason: proposal.reason,
          actions: [
            {
              table: "staging.candidate",
              op: "insert",
              args: {
                proposed_kind: proposal.entityKind,
                display_name: proposal.displayName,
              },
            },
          ],
        };
      case "report.publish":
        return {
          outcome: "rejected",
          reason: "LEGACY_REPORT_PUBLISH_UNSUPPORTED",
          actions: [],
        };
    }
  }

  /** Support needs a locator and a claim row that exists now or will be materialized by this intent. */
  private supportOutcome(proposal: ProposalOf<"support.admit">, claimArg: string | null): OutcomeSlice {
    const cited = proposal.evidence[0];
    const sourceEvidence = cited
      ? this.claimFact(cited.runId, cited.claimId)?.authoritative?.provenance?.evidence
      : undefined;
    if (!proposal.locatorId && sourceEvidence?.length !== 1)
      return { outcome: "held", reason: "locator_required", actions: [] };
    const claimRowExists = Boolean(cited && this.claimFact(cited.runId, cited.claimId)?.claimRowId);
    const materializedHere =
      this.hasClaimProducer() &&
      cited !== undefined &&
      this.intent.proposals.some(
        (item) =>
          item.kind === "claim.materialize" && item.runId === cited.runId && item.claimIds.includes(cited.claimId),
      );
    if (!claimRowExists && !materializedHere) return { outcome: "held", reason: "claim_row_required", actions: [] };
    return {
      outcome: "admitted",
      actions: [
        {
          fn: "temporal.admit_support",
          args: {
            target: proposal.targetRef,
            role: proposal.supportRole,
            claim: claimArg,
            locator: proposal.locatorId,
          },
        },
      ],
    };
  }

  /** A materialized claim names its producer: the orchestration attempt or the exact-use originating origin. */
  private hasClaimProducer(): boolean {
    return Boolean(this.intent.context.attemptId) || Boolean(this.intent.exactUse?.originatingOrigin);
  }

  private materializeOutcome(proposal: ProposalOf<"claim.materialize">): OutcomeSlice {
    if (!this.hasClaimProducer())
      return {
        outcome: "held",
        reason: "attempt_or_origin_required",
        actions: [],
      };
    const missing = proposal.claimIds.filter(
      (claimId) =>
        !this.claimFact(proposal.runId, claimId)?.authoritative &&
        !this.intent.evidence.claims.some((claim) => claim.runId === proposal.runId && claim.claimId === claimId),
    );
    if (missing.length > 0)
      return {
        outcome: "held",
        reason: `claim_text_missing:${missing.join(",")}`,
        actions: [],
      };
    const existing = proposal.claimIds.filter((claimId) => this.claimFact(proposal.runId, claimId)?.claimRowId);
    if (existing.length === proposal.claimIds.length)
      return {
        outcome: "no_op_duplicate",
        existing: { claimIds: existing },
        actions: [],
      };
    return {
      outcome: "admitted",
      actions: proposal.claimIds.map((claimId) => ({
        table: "evidence.claim",
        op: "insert_if_absent",
        args: { runId: proposal.runId, claimId },
      })),
    };
  }

  /** A held prerequisite holds its dependent closure, while unrelated complete proposals remain applicable. */
  closeDependencies(proposals: readonly PlannedProposal[]): PlannedProposal[] {
    let result = [...proposals];
    let changed = true;
    while (changed) {
      changed = false;
      result = result.map((proposal) => {
        if (!["admitted", "superseded", "no_op_duplicate"].includes(proposal.outcome)) return proposal;
        const missingClaim =
          proposal.kind !== "claim.materialize" &&
          proposal.kind !== "candidate.stage" &&
          proposalClaims(proposal.effective).some((ref) => {
            const fact = this.claimFact(ref.runId, ref.claimId);
            return (
              !fact?.claimRowId &&
              !fact?.fixtureOnly &&
              !result.some(
                (item) =>
                  item.effective.kind === "claim.materialize" &&
                  item.effective.runId === ref.runId &&
                  item.effective.claimIds.includes(ref.claimId),
              )
            );
          });
        const blocked = [...this.dependenciesOf(proposal, result), ...this.claimSubjectCreators(proposal, result)].find(
          (id) => {
            const dependency = result.find((item) => item.proposalId === id);
            return dependency && !["admitted", "superseded", "no_op_duplicate"].includes(dependency.outcome);
          },
        );
        if (!missingClaim && !blocked) return proposal;
        changed = true;
        return {
          ...proposal,
          outcome: "held",
          reason: missingClaim ? "claim_row_required" : `dependency_held:${blocked}`,
          actions: [],
        };
      });
    }
    return result;
  }

  /** Claim rows precede entities, but their deferred subject links require admitted entity creation. */
  private claimSubjectCreators(proposal: PlannedProposal, proposals: readonly PlannedProposal[]): string[] {
    if (proposal.effective.kind !== "claim.materialize") return [];
    const materializer = proposal.effective;
    const bindings = materializer.claimIds.flatMap(
      (claimId) => this.claimFact(materializer.runId, claimId)?.authoritative?.entityBindings ?? [],
    );
    const refs = this.intent.subjects
      .filter(
        (subject) =>
          subject.mode === "new" &&
          bindings.some(
            (binding) =>
              binding.canonicalId ===
              deterministicId(
                "corpus.entity",
                [this.intent.context.tenantId, this.intent.intentId, subject.ref].join(NULL_SEPARATOR),
              ),
          ),
      )
      .map((subject) => subject.ref);
    return proposals
      .filter((item) => item.effective.kind === "entity.create" && refs.includes(item.effective.subjectRef))
      .map((item) => item.proposalId);
  }

  private dependenciesOf(proposal: PlannedProposal, proposals: readonly PlannedProposal[]): string[] {
    const dependencies = new Set(proposal.effective.dependsOn);
    if (proposal.effective.kind === "support.admit") {
      const targetRef = proposal.effective.targetRef;
      if (proposals.some((item) => item.proposalId === targetRef)) dependencies.add(targetRef);
    }
    if (proposal.kind !== "claim.materialize" && proposal.kind !== "candidate.stage")
      for (const ref of proposalClaims(proposal.effective)) {
        const fact = this.claimFact(ref.runId, ref.claimId);
        if (fact?.claimRowId || fact?.fixtureOnly) continue;
        const materializer = proposals.find(
          (item) =>
            item.effective.kind === "claim.materialize" &&
            item.effective.runId === ref.runId &&
            item.effective.claimIds.includes(ref.claimId),
        );
        if (materializer) dependencies.add(materializer.proposalId);
      }
    const subjectRefs = subjectRefsOf(proposal.effective);
    if (proposal.effective.kind === "entity.create") {
      const create = proposal.effective;
      const subject = this.intent.subjects.find((item) => item.ref === create.subjectRef);
      if (subject?.mode === "new")
        for (const value of Object.values(subject.typedPayload)) {
          const ref = subjectRefOfPlaceholder(value);
          if (ref) subjectRefs.push(ref);
        }
    }
    for (const ref of subjectRefs) {
      const creator = proposals.find(
        (item) => item.effective.kind === "entity.create" && item.effective.subjectRef === ref,
      );
      if (creator && creator.proposalId !== proposal.proposalId) dependencies.add(creator.proposalId);
    }
    return [...dependencies];
  }

  /** Dependency groups (claims → candidates → entities → aliases → relationships → facts → events → supports → metrics → report), then explicit `dependsOn`. */
  orderProposals(proposals: readonly PlannedProposal[]): string[] {
    const grouped = [...proposals].sort(
      (a, b) => GROUP_ORDER.indexOf(a.kind) - GROUP_ORDER.indexOf(b.kind) || a.ordinal - b.ordinal,
    );
    const byId = new Map(proposals.map((proposal) => [proposal.proposalId, proposal]));
    const ordered: PlannedProposal[] = [];
    const placed = new Set<string>();
    const visit = (proposal: PlannedProposal, trail: Set<string>): void => {
      if (placed.has(proposal.proposalId)) return;
      if (trail.has(proposal.proposalId)) {
        this.fail({
          code: "INTENT_SCHEMA_INVALID",
          message: `dependsOn cycle through ${proposal.proposalId}`,
          proposalId: proposal.proposalId,
        });
        return;
      }
      trail.add(proposal.proposalId);
      for (const dependency of this.dependenciesOf(proposal, proposals)) {
        const target = byId.get(dependency);
        if (target) visit(target, trail);
      }
      trail.delete(proposal.proposalId);
      placed.add(proposal.proposalId);
      ordered.push(proposal);
    };
    for (const proposal of grouped) visit(proposal, new Set());
    return ordered.map((proposal) => proposal.proposalId);
  }

  private fail(error: PlanError): void {
    this.errors.push(error);
  }
}

function entityCreateOutcome(planned: PlannedSubject | undefined): OutcomeSlice {
  if (planned?.resolution === "use_existing")
    return {
      outcome: "no_op_duplicate",
      reason: "use_existing",
      existing: { entityId: planned.entityId },
      actions: [],
    };
  return {
    outcome: "admitted",
    actions: [
      {
        table: "staging.candidate",
        op: "insert",
        args: { kind: planned?.kind },
      },
      {
        table: "staging.resolution_decision",
        op: "insert",
        args: { decision: "create" },
      },
      {
        table: "corpus.entity",
        op: "insert",
        args: {
          id: planned?.entityId,
          kind: planned?.kind,
          slug: planned?.slug,
        },
      },
      { fn: "temporal.assert_state", args: { stream_kind: "entity_name" } },
    ],
  };
}

function touchedProposals(intent: IngestionIntent, changed: readonly ChangedItem[]): string[] {
  return intent.proposals
    .filter((proposal) => changed.some((item) => touches(proposal, item)))
    .map((proposal) => proposal.proposalId);
}

function touches(proposal: Proposal, item: ChangedItem): boolean {
  const refs = subjectRefsOf(proposal);
  if (!refs.includes(item.subjectRef)) return false;
  switch (proposal.kind) {
    case "fact.assert_state":
      return (
        item.itemKind === "segment" &&
        item.streamKind === proposal.streamKind &&
        (item.scopeKey ?? "") === (proposal.scopeKey ?? "")
      );
    case "relationship.assert":
      return item.itemKind === "relationship" && item.relationshipKind === proposal.relationshipKind;
    case "event.assert":
      return item.itemKind === "event" && item.eventKind === proposal.eventKind;
    default:
      return false;
  }
}

function summarize(proposals: readonly PlannedProposal[]): Record<ProposalOutcome, number> {
  const summary: Record<ProposalOutcome, number> = {
    admitted: 0,
    no_op_duplicate: 0,
    superseded: 0,
    review_required: 0,
    held: 0,
    quarantined: 0,
    rejected: 0,
  };
  for (const proposal of proposals) summary[proposal.outcome] += 1;
  return summary;
}
