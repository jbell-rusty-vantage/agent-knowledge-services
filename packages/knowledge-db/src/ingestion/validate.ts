import { validateSchema } from "../db-read/index.js";
import type { Proposal } from "./intent.js";
import type { Vocabulary } from "./vocabulary.js";

/**
 * Vocabulary validity (executor phase 5). These checks duplicate what the database enforces
 * at `commit_batch` so the agent receives a readable `VOCABULARY_VIOLATION` naming the
 * allowed values before any transaction is opened.
 */
export interface VocabularyIssue {
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
}

export interface ValidationContext {
  readonly vocabulary: Vocabulary;
  readonly subjects: ReadonlyMap<string, { readonly kind: string }>;
}

const CURRENCY = /^[A-Z]{3}$/;
const MONETARY_STREAMS = new Set(["model_offering_price", "compute_offering_price", "valuation"]);

export function validateProposal(proposal: Proposal, context: ValidationContext): VocabularyIssue[] {
  switch (proposal.kind) {
    case "relationship.assert":
      return validateRelationship(proposal, context);
    case "fact.assert_state":
      return validateFact(proposal, context);
    case "event.assert":
      return validateEvent(proposal, context);
    case "candidate.stage":
      return context.vocabulary.entityKinds.has(proposal.entityKind)
        ? []
        : [
            violation(proposal.proposalId, `unknown entity kind ${proposal.entityKind}`, {
              allowed: [...context.vocabulary.entityKinds.keys()],
            }),
          ];
    default:
      return [];
  }
}

const violation = (proposalId: string, message: string, details?: unknown): VocabularyIssue => ({
  code: "VOCABULARY_VIOLATION",
  message: `${proposalId}: ${message}`,
  ...(details === undefined ? {} : { details }),
});
const kindOf = (context: ValidationContext, ref: string): string | undefined => context.subjects.get(ref)?.kind;

function validateRelationship(
  proposal: Extract<Proposal, { kind: "relationship.assert" }>,
  context: ValidationContext,
): VocabularyIssue[] {
  const kind = context.vocabulary.relationshipKinds.get(proposal.relationshipKind);
  if (!kind)
    return [
      violation(proposal.proposalId, `unknown relationship kind ${proposal.relationshipKind}`, {
        allowed: [...context.vocabulary.relationshipKinds.keys()],
      }),
    ];
  const issues: VocabularyIssue[] = [];
  if (kind.temporal && (proposal.temporalBasis !== "explicit" || proposal.belief !== "accepted"))
    issues.push(
      violation(proposal.proposalId, "temporal relationship helper supports only explicit accepted assertions"),
    );
  if (!kind.temporal && proposal.extent)
    issues.push(violation(proposal.proposalId, "non-temporal relationship cannot preserve an extent"));
  const fromKind = kindOf(context, proposal.fromRef);
  const toKind = kindOf(context, proposal.toRef);
  if (fromKind && !kind.fromKinds.includes(fromKind))
    issues.push(
      violation(proposal.proposalId, `${proposal.relationshipKind} does not admit from-kind ${fromKind}`, {
        allowed: kind.fromKinds,
      }),
    );
  if (toKind && !kind.toKinds.includes(toKind))
    issues.push(
      violation(proposal.proposalId, `${proposal.relationshipKind} does not admit to-kind ${toKind}`, {
        allowed: kind.toKinds,
      }),
    );
  if (kind.temporal && !proposal.worldInterval?.from)
    issues.push(
      violation(proposal.proposalId, `${proposal.relationshipKind} is temporal and requires worldInterval.from`),
    );
  if (!kind.temporal && proposal.worldInterval)
    issues.push(
      violation(proposal.proposalId, `${proposal.relationshipKind} is not temporal and rejects worldInterval`),
    );
  const propertyIssues = validateSchema(kind.propertySchema, proposal.properties);
  if (propertyIssues.length > 0)
    issues.push(
      violation(proposal.proposalId, "properties violate relationship_kind.property_schema", {
        issues: propertyIssues,
      }),
    );
  return issues;
}

function validateFact(
  proposal: Extract<Proposal, { kind: "fact.assert_state" }>,
  context: ValidationContext,
): VocabularyIssue[] {
  const stream = context.vocabulary.streamKinds.get(proposal.streamKind);
  if (!stream)
    return [
      violation(proposal.proposalId, `unknown stream kind ${proposal.streamKind}`, {
        allowed: [...context.vocabulary.streamKinds.keys()],
      }),
    ];
  const issues: VocabularyIssue[] = [];
  if (
    proposal.amount !== undefined &&
    (Math.abs(proposal.amount) >= 1e14 || Number(proposal.amount.toFixed(6)) !== proposal.amount)
  )
    issues.push(violation(proposal.proposalId, "amount must fit numeric(20,6) without rounding"));
  if (!proposal.worldInterval.from)
    issues.push(
      violation(proposal.proposalId, "worldInterval.from is required for facts (valid_during is bounded below)"),
    );
  if (stream.subjectMode === "entity" && !proposal.subjectRef)
    issues.push(violation(proposal.proposalId, `${proposal.streamKind} is an entity stream and needs subjectRef`));
  if (stream.subjectMode === "relationship" && !proposal.relationshipRef)
    issues.push(
      violation(proposal.proposalId, `${proposal.streamKind} is a relationship stream and needs relationshipRef`),
    );
  const subjectKind = proposal.subjectRef ? kindOf(context, proposal.subjectRef) : undefined;
  if (subjectKind && !stream.subjectKinds.includes(subjectKind))
    issues.push(
      violation(proposal.proposalId, `${proposal.streamKind} does not admit subject kind ${subjectKind}`, {
        allowed: stream.subjectKinds,
      }),
    );
  if (stream.statusValues && (proposal.status === undefined || !stream.statusValues.includes(proposal.status)))
    issues.push(
      violation(proposal.proposalId, `status must be one of ${JSON.stringify(stream.statusValues)}`, {
        allowed: stream.statusValues,
        got: proposal.status ?? null,
      }),
    );
  if (stream.requiresAmount && (proposal.amount === undefined || proposal.unit === undefined))
    issues.push(violation(proposal.proposalId, `${proposal.streamKind} requires amount and unit`));
  if (stream.unitValues && proposal.unit !== undefined && !stream.unitValues.includes(proposal.unit))
    issues.push(
      violation(proposal.proposalId, `unit ${proposal.unit} is not allowed for ${proposal.streamKind}`, {
        allowed: stream.unitValues,
        field: "unit",
      }),
    );
  if (MONETARY_STREAMS.has(proposal.streamKind) && !(proposal.currency && CURRENCY.test(proposal.currency)))
    issues.push(
      violation(proposal.proposalId, `${proposal.streamKind} requires currency matching ^[A-Z]{3}$`, {
        field: "currency",
      }),
    );
  if (stream.requiresRefEntity && !proposal.refEntityRef)
    issues.push(violation(proposal.proposalId, `${proposal.streamKind} requires refEntityRef`));
  if ((proposal.temporalBasis === "explicit" || proposal.temporalBasis === "carry_forward") && !proposal.extent)
    issues.push(
      violation(proposal.proposalId, `temporalBasis ${proposal.temporalBasis} requires an extent`, { field: "extent" }),
    );
  const payloadIssues = validateSchema(stream.payloadSchema, proposal.payload);
  if (payloadIssues.length > 0)
    issues.push(
      violation(proposal.proposalId, "payload violates stream_kind.payload_schema", { issues: payloadIssues }),
    );
  return issues;
}

function validateEvent(
  proposal: Extract<Proposal, { kind: "event.assert" }>,
  context: ValidationContext,
): VocabularyIssue[] {
  const kind = context.vocabulary.eventKinds.get(proposal.eventKind);
  if (!kind)
    return [
      violation(proposal.proposalId, `unknown event kind ${proposal.eventKind}`, {
        allowed: [...context.vocabulary.eventKinds.keys()],
      }),
    ];
  const issues: VocabularyIssue[] = [];
  if (proposal.extent && proposal.precision && proposal.extent.precision !== proposal.precision)
    issues.push(violation(proposal.proposalId, "event precision contradicts extent precision"));
  const subjectKind = kindOf(context, proposal.subjectRef);
  if (subjectKind && !kind.subjectKinds.includes(subjectKind))
    issues.push(
      violation(proposal.proposalId, `${proposal.eventKind} does not admit subject kind ${subjectKind}`, {
        allowed: kind.subjectKinds,
      }),
    );
  const objectKind = proposal.objectRef ? kindOf(context, proposal.objectRef) : undefined;
  if (objectKind && kind.objectKinds && !kind.objectKinds.includes(objectKind))
    issues.push(
      violation(proposal.proposalId, `${proposal.eventKind} does not admit object kind ${objectKind}`, {
        allowed: kind.objectKinds,
      }),
    );
  if (!proposal.occurredDuring.from) issues.push(violation(proposal.proposalId, "occurredDuring.from is required"));
  return issues;
}
