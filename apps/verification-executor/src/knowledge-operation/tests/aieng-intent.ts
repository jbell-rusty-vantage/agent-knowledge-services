/**
 * AI Engineer native intent for a frozen, independently judged KS report (knowledge-ingestion-intent.v1).
 *
 * The agent authors subjects and domain proposals and selects which frozen assertions to materialize. The host owns
 * everything the frozen report determines: inline claim text, the verification run, `claim.materialize`,
 * the read snapshot, context, declared use and the exact-use binding. Only assertions with an actual
 * independent `full_support` judgment are eligible. This builds and checks bytes; KS policy decides admission.
 */
import { IngestionPreviewIntentSchema, ProposalSchema, SubjectSchema } from "@aiengineer/knowledge-db";
import type { Origin } from "@aiengineer/knowledge-operation-protocol";
import type { FrozenQualiaReport } from "./qualia-frozen.js";

export const AIENG_USE = { use: "knowledge_ingestion.ai_engineer", audience: "internal" } as const;
/** Host-owned proposal kinds: the frozen report and its judgments determine them. */
const HOST_OWNED = new Set(["report.publish", "claim.materialize", "support.admit"]);
const CLAIM_TYPES = new Set([
  "attribute",
  "capability",
  "causal",
  "comparative",
  "compatibility",
  "definition",
  "event",
  "measurement",
  "methodological",
  "other",
  "provenance",
  "recommendation",
  "relationship",
  "temporal",
]);

export interface AiengNativeInput {
  intentId: string;
  subjects: unknown[];
  proposals: unknown[];
  claims: Array<{
    assertionId: string;
    claimType?: string;
    subjects?: Array<{ ref: string; role?: "subject" | "object" | "context" }>;
  }>;
  notes?: string;
}

export class AiengIntentRefused extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(`${code}: ${message}`);
    this.name = "AiengIntentRefused";
  }
}

/** Inline-claim qualifier strings: only reported (non-null) values, never invented ones. */
function qualifierStrings(qualifiers: Record<string, unknown>): string[] {
  return Object.entries(qualifiers)
    .filter(([key, value]) => key !== "profile" && value !== null && value !== undefined)
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`.slice(0, 240))
    .slice(0, 16);
}

/** Every evidence ref the agent authored, wherever it appears. */
function citedClaimIds(value: unknown, found: Set<string>): Set<string> {
  if (Array.isArray(value)) for (const item of value) citedClaimIds(item, found);
  else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.evidence))
      for (const ref of record.evidence)
        if (ref && typeof ref === "object" && typeof (ref as { claimId?: unknown }).claimId === "string")
          found.add((ref as { claimId: string }).claimId);
    for (const [key, nested] of Object.entries(record)) if (key !== "evidence") citedClaimIds(nested, found);
  }
  return found;
}

/** Rewrite each authored evidence ref onto the one declared verification run. */
function bindEvidence<T>(value: T, runId: string): T {
  if (Array.isArray(value)) return value.map((item) => bindEvidence(item, runId)) as T;
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    out[key] =
      key === "evidence" && Array.isArray(nested)
        ? nested.map((ref) => ({ ...(ref as Record<string, unknown>), runId }))
        : bindEvidence(nested, runId);
  }
  return out as T;
}

export function fullySupported(frozen: FrozenQualiaReport): Map<string, FrozenQualiaReport["assertions"][number]> {
  return new Map(
    frozen.assertions
      .filter(
        (assertion) =>
          assertion.judgments.length > 0 &&
          assertion.judgments.every((judgment) => judgment.outcome.verdict === "full_support"),
      )
      .map((assertion) => [assertion.id, assertion]),
  );
}

export function buildAiengIntent(input: {
  authored: AiengNativeInput;
  frozen: FrozenQualiaReport;
  /** The KS verification run of the frozen report. */
  verificationRunId: string;
  asOf: string;
  context: {
    tenantId: string;
    correlationId?: string;
    missionId?: string;
    attemptId?: string;
    actor?: Record<string, unknown>;
  };
  snapshot: { artifactId?: string; snapshotId: string; snapshotDigest: string; knowledgeSeq: number };
  effectKey: string;
  origin: Origin;
}) {
  const { authored, frozen } = input;
  if (!Array.isArray(authored.subjects) || !Array.isArray(authored.proposals) || !Array.isArray(authored.claims))
    throw new AiengIntentRefused("NATIVE_INPUT_SHAPE", "native_input needs subjects, proposals and claims arrays");
  const issues: Array<Record<string, unknown>> = [];
  // Evidence refs name only claimIds; the one declared verification run is host-owned.
  const runId = input.verificationRunId;
  const subjects = bindEvidence(authored.subjects, runId);
  const proposals = bindEvidence(authored.proposals, runId);
  subjects.forEach((subject, index) => {
    const parsed = SubjectSchema.safeParse(subject);
    if (!parsed.success) issues.push({ path: `/subjects/${index}`, issues: parsed.error.issues.slice(0, 5) });
  });
  proposals.forEach((proposal, index) => {
    const kind = (proposal as { kind?: unknown })?.kind;
    if (typeof kind === "string" && HOST_OWNED.has(kind))
      issues.push({ path: `/proposals/${index}`, error: `${kind} is host-owned; author domain proposals only` });
    else {
      const parsed = ProposalSchema.safeParse(proposal);
      if (!parsed.success) issues.push({ path: `/proposals/${index}`, issues: parsed.error.issues.slice(0, 5) });
    }
  });
  const eligible = fullySupported(frozen);
  const selected = new Map<string, AiengNativeInput["claims"][number]>();
  authored.claims.forEach((claim, index) => {
    if (!eligible.has(claim.assertionId))
      issues.push({
        path: `/claims/${index}`,
        error: "assertion is not a frozen assertion with only full_support judgments",
        assertionId: claim.assertionId,
      });
    else if (selected.has(claim.assertionId))
      issues.push({ path: `/claims/${index}`, error: "assertion selected twice" });
    else if (
      (claim.subjects ?? []).some(
        (subject) =>
          !["subject", "object", "context"].includes(subject.role ?? "subject") ||
          !(authored.subjects as Array<{ ref?: unknown }>).some(
            (authoredSubject) => authoredSubject.ref === subject.ref,
          ),
      )
    )
      issues.push({
        path: `/claims/${index}/subjects`,
        error: "claim subjects name an authored subject ref with role subject, object or context",
      });
    else if (claim.claimType !== undefined && !CLAIM_TYPES.has(claim.claimType))
      issues.push({ path: `/claims/${index}/claimType`, error: "unregistered claimType" });
    else selected.set(claim.assertionId, claim);
  });
  if (selected.size === 0) issues.push({ path: "/claims", error: "select at least one fully supported assertion" });
  const cited = citedClaimIds([authored.subjects, authored.proposals], new Set());
  for (const claimId of cited)
    if (!selected.has(claimId)) issues.push({ error: "evidence cites an unselected or ineligible claimId", claimId });
  if (issues.length)
    throw new AiengIntentRefused("NATIVE_INPUT_INVALID", "native_input does not bind to the frozen report", {
      issues,
      eligibleAssertionIds: [...eligible.keys()],
    });
  const claims = [...selected.values()].map((claim) => {
    const assertion = eligible.get(claim.assertionId)!;
    return {
      runId,
      claimId: assertion.id,
      claimType: claim.claimType ?? "attribute",
      statement: assertion.proposition,
      qualifiers: qualifierStrings(assertion.qualifiers as Record<string, unknown>),
      verdict: "full_support",
      subjects: claim.subjects ?? [],
    };
  });
  const claimIds = claims.map((claim) => claim.claimId);
  const intent = IngestionPreviewIntentSchema.parse({
    schemaVersion: "knowledge-ingestion-intent.v1",
    intentId: authored.intentId,
    context: input.context,
    inputSnapshot: input.snapshot,
    expectedKnowledgeHead: input.snapshot.knowledgeSeq,
    onStale: "rebase_if_disjoint",
    asOf: input.asOf,
    evidence: { verificationRuns: [{ runId }], claims },
    subjects,
    proposals: [
      ...proposals,
      {
        proposalId: "materialize-claims",
        kind: "claim.materialize",
        runId,
        claimIds,
        evidence: claimIds.map((claimId) => ({ runId, claimId })),
      },
    ],
    ...(authored.notes ? { notes: authored.notes } : {}),
    exactUse: { effectKey: input.effectKey, originatingOrigin: input.origin },
    declaredUse: AIENG_USE,
  });
  return {
    intent,
    reportBinding: {
      reportRevisionId: frozen.reportRevisionId,
      bodyDigest: frozen.bodyDigest,
      ledgerDigest: frozen.ledgerDigest,
      structuredBodyDigest: frozen.structuredBodyDigest,
      claimIds,
    },
  };
}
