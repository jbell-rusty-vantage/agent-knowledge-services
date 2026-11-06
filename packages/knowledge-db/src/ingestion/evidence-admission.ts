import { canonicalJson } from "../db-read/index.js";
import { subjectRefsOf, type IngestionIntent, type Proposal } from "./intent.js";
import { deterministicId, STRONG_MATCH, type ClaimFacts, type PlanFacts } from "./plan.js";
import type { VocabularyIssue } from "./validate.js";

/** A trusted oracle hydrates these fields from registered, sealed artifact bytes. */
export interface AuthoritativeClaim {
  readonly statement: string;
  readonly claimType: string;
  readonly qualifiers: readonly string[];
  readonly value?: string | number | boolean | null;
  readonly entityBindings: readonly { role: string; canonicalId: string }[];
  readonly verdict: string;
  readonly manifestDigest: string;
  readonly policyVersion: string;
  readonly downstreamUse: readonly string[];
  readonly provenance?: {
    readonly tenantId: string;
    readonly auditArtifactId: string;
    readonly policyArtifactId: string;
    readonly policyDigest: string;
    readonly decisionArtifactId: string;
    readonly decisionDigest: string;
    readonly outcome: string;
    readonly run: {
      readonly runId: string;
      readonly producerAttemptId: string;
      readonly producerDeploymentId: string;
      readonly verifierAttemptId: string;
      readonly verifierDeploymentId: string;
      readonly bundleArtifactId: string;
      readonly resultArtifactId: string;
      readonly auditDigest: string;
      readonly startedAt: string;
      readonly completedAt: string;
    };
    readonly assessment: {
      readonly properties: Readonly<Record<string, unknown>>;
      readonly supportingFragmentIds: readonly string[];
      readonly contradictingFragmentIds: readonly string[];
      readonly unsupportedFacets: readonly string[];
      readonly reasonCodes: readonly string[];
      readonly inputsDigest: string;
      readonly outputSchemaDigest: string;
    };
    readonly evidence: readonly {
      readonly source: {
        readonly sourceId: string;
        readonly kind: string;
        readonly canonicalUri: string;
        readonly logicalIdentity: string;
      };
      readonly capture: {
        readonly captureId: string;
        readonly capturedAt: string;
        readonly captureMethod: string;
        readonly captureMethodVersion: string;
        readonly artifactId: string;
        readonly digest: string;
        readonly mediaType: string;
        readonly byteLength: number;
      };
      readonly fragmentId: string;
      readonly representationArtifactId: string;
      readonly selector: Readonly<Record<string, unknown>>;
      readonly selectedContentDigest: string;
      readonly selectedSizeBytes: number;
      readonly occurrenceCount: number;
      readonly selectorDigest: string;
      readonly normalization: string;
      readonly resolverVersion: string;
      readonly role: string;
      readonly authority: Readonly<Record<string, string>>;
      readonly parserLineageArtifactIds: readonly string[];
    }[];
  };
}
export interface ReportEvidence {
  readonly eligible: boolean;
  readonly reason?: string;
}
export interface ClaimEligibility {
  readonly eligible: boolean;
  readonly verdict?: string;
  readonly authoritative?: AuthoritativeClaim;
  readonly fixtureOnly?: boolean;
}

const OFFICIALLY_ADMITTED_VERDICTS = new Set([
  "directly_supported",
  "supported_with_qualification",
  "derived_verified",
  "literal_extraction_verified",
]);

/** Official knowledge uses `evidence.claim.status=verified`; that is not a synonym for `directly_supported`. */
export function isOfficiallyAdmittedVerdict(verdict: string): boolean {
  return OFFICIALLY_ADMITTED_VERDICTS.has(verdict);
}

/** New identities are authenticated using the same deterministic ID that apply will create. */
export function subjectIdentity(intent: IngestionIntent, facts: PlanFacts, ref: string): string | undefined {
  const subject = intent.subjects.find((item) => item.ref === ref);
  if (!subject) return undefined;
  if (subject.mode === "resolved") return subject.entityId;
  const strong = facts.subjects[ref]?.matches?.find((match) => match.score >= STRONG_MATCH);
  if (strong) return subject.onMatch === "use_existing" && strong.kind === subject.kind ? strong.entityId : undefined;
  return deterministicId("corpus.entity", [intent.context.tenantId, intent.intentId, ref].join("\0"));
}

export function proposalClaims(proposal: Proposal): readonly { runId: string; claimId: string }[] {
  if (proposal.kind === "claim.materialize")
    return proposal.claimIds.map((claimId) => ({ runId: proposal.runId, claimId }));
  if (proposal.kind === "report.publish") return proposal.claimRefs ?? [];
  return proposal.evidence;
}

/** Exact normalized effect encoding for scalar claim values; prose alone cannot authorize SQL effects. */
export function proposalEffect(intent: IngestionIntent, proposal: Proposal): string {
  const {
    proposalId: _id,
    evidence: _evidence,
    dependsOn: _dependencies,
    rationale: _rationale,
    proposition: _statement,
    qualifiers: _qualifiers,
    ...effect
  } = proposal;
  const subjects = subjectRefsOf(proposal).map((ref) => intent.subjects.find((subject) => subject.ref === ref) ?? null);
  return canonicalJson({ effect, subjects });
}

export function admissionIssues(input: {
  intent: IngestionIntent;
  proposal: Proposal;
  facts: PlanFacts;
}): VocabularyIssue[] {
  const { intent, proposal, facts } = input;
  if (proposal.kind === "candidate.stage") return [];
  const issue = (code: string): VocabularyIssue[] => [{ code, message: `${proposal.proposalId}: ${code}` }];
  const references = proposalClaims(proposal);
  if (!references.length) return issue("EVIDENCE_REQUIRED");
  const claims = references.map((ref) =>
    facts.claims.find((claim) => claim.runId === ref.runId && claim.claimId === ref.claimId),
  );
  if (claims.some((claim) => !claim?.eligible)) return issue("EVIDENCE_NOT_ELIGIBLE");
  const verified = claims as ClaimFacts[];
  if (proposal.kind !== "record.materialize" && verified.every((claim) => claim.fixtureOnly)) return [];
  if (verified.some((claim) => !claim.authoritative)) return issue("AUTHORITATIVE_CLAIM_REQUIRED");
  if (
    proposal.kind === "record.materialize" &&
    verified.some(
      (claim) =>
        claim.authoritative?.verdict !== "directly_supported" ||
        !claim.authoritative.entityBindings.some(
          (binding) =>
            binding.role === "subject" && binding.canonicalId === subjectIdentity(intent, facts, proposal.subjectRef),
        ),
    )
  ) {
    return issue("RECORD_VERIFIED_SUBJECT_REQUIRED");
  }
  for (const claim of verified) {
    const authoritative = claim.authoritative!;
    const use =
      proposal.kind === "report.publish" ? "source_attributed_report" : `knowledge_ingestion:${proposal.kind}`;
    if (!authoritative.downstreamUse.includes(use)) return issue("EVIDENCE_INTENDED_USE_MISMATCH");
    const inline = intent.evidence.claims.find((item) => item.runId === claim.runId && item.claimId === claim.claimId);
    if (
      inline &&
      (inline.statement !== authoritative.statement ||
        inline.claimType !== authoritative.claimType ||
        (inline.verdict !== undefined && inline.verdict !== authoritative.verdict) ||
        canonicalJson(inline.qualifiers ?? []) !== canonicalJson(authoritative.qualifiers))
    )
      return issue("INLINE_CLAIM_MISMATCH");
    if (
      inline?.subjects.some((subject) => {
        const resolved = intent.subjects.find((item) => item.ref === subject.ref);
        return (
          !resolved ||
          !authoritative.entityBindings.some(
            (binding) =>
              binding.role === subject.role && binding.canonicalId === subjectIdentity(intent, facts, resolved.ref),
          )
        );
      })
    )
      return issue("CLAIM_SUBJECT_REVERIFICATION_REQUIRED");
    if (proposal.kind !== "claim.materialize" && proposal.kind !== "report.publish") {
      if (
        proposal.proposition !== authoritative.statement ||
        canonicalJson(proposal.qualifiers ?? []) !== canonicalJson(authoritative.qualifiers) ||
        authoritative.value !== proposalEffect(intent, proposal)
      )
        return issue("PROPOSAL_REVERIFICATION_REQUIRED");
    }
    if (
      proposal.kind === "claim.materialize" &&
      authoritative.entityBindings.some(
        (binding) =>
          !["subject", "object", "context"].includes(binding.role) ||
          !intent.subjects.some((subject) => subjectIdentity(intent, facts, subject.ref) === binding.canonicalId),
      )
    )
      return issue("CLAIM_SUBJECT_REVERIFICATION_REQUIRED");
  }
  if (proposal.kind === "report.publish" && !facts.reports?.[proposal.proposalId]?.eligible)
    return issue("REPORT_BINDING_REQUIRED");
  return [];
}
