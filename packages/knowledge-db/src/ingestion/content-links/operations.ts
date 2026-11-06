import { ContentLinkOperationSchema, type ContentLinkOperation } from "@aiengineer/knowledge-contracts";
import { canonicalJson } from "../../db-read/index.js";
import { sha256Digest } from "@aiengineer/knowledge-core";
import type { KnowledgeSqlClient } from "../../ports.js";
import { isOfficiallyAdmittedVerdict } from "../evidence-admission.js";
import { deterministicId } from "../plan.js";
import type { ContentSourceReader, ContentSourceNode } from "./sources.js";
import type { AuthenticatedContentEvidence, ContentLinkOperationResult, ContentLinkRowReference } from "./types.js";
import { sameContentInstant } from "./timestamps.js";

type Row = Record<string, unknown>;
type SummaryOperation = Extract<ContentLinkOperation, { kind: "summary.materialize" }>;
export interface ContentOperationContext {
  readonly client: KnowledgeSqlClient;
  readonly tenantId: string;
  readonly attemptId: string;
  readonly receiptId?: string;
  readonly sources: ContentSourceReader;
  readonly evidence: readonly AuthenticatedContentEvidence[];
  readonly priorPrepared?: ReadonlyMap<string, PreparedContentOperation>;
}
export interface PreparedContentOperation {
  readonly result: ContentLinkOperationResult;
}
interface Write {
  readonly sql: string;
  readonly values: readonly unknown[];
}
interface Preparation {
  readonly operation: ContentLinkOperation;
  readonly context: ContentOperationContext;
  readonly writes: Write[];
  readonly refs: ContentLinkRowReference[];
}
const preparations = new WeakMap<PreparedContentOperation, Preparation>();
const faithfulClasses = new Set(["source_native", "faithful_normalization", "structural_extraction"]);
class HeldOperation extends Error {}
function hold(code: string): never {
  throw new HeldOperation(code);
}
const equal = (left: unknown, right: unknown): boolean => canonicalJson(left) === canonicalJson(right);

/** The sealed claim value binds the complete effect without recursively including its own evidence digest. */
export function contentLinkEffect(operation: ContentLinkOperation): string {
  const {
    operationId: _operationId,
    dependsOn: _dependsOn,
    evidence: _evidence,
    rationale: _rationale,
    ...effect
  } = operation;
  return canonicalJson(effect);
}

/** Read-only admission; prepared writes stay private and cannot be supplied through the proposal contract. */
export async function prepareContentOperation(
  context: ContentOperationContext,
  proposed: ContentLinkOperation,
): Promise<PreparedContentOperation> {
  const operation = ContentLinkOperationSchema.parse(structuredClone(proposed));
  const preparation: Preparation = { context, operation, writes: [], refs: [] };
  let reasons: string[] = [];
  try {
    validateNumericPrecision(operation);
    validateEvidence(context, operation);
    await inspectOperation(preparation);
  } catch (error) {
    if (error instanceof HeldOperation) reasons = [error.message];
    else if (
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string" &&
      /^(CONTENT_SOURCE_|CONTENT_CHUNK_)/.test(error.code)
    )
      reasons = [error.code];
    else throw error;
  }
  const prepared: PreparedContentOperation = {
    result: Object.freeze({
      operationId: operation.operationId,
      kind: operation.kind,
      outcome: reasons.length ? "held" : preparation.writes.length ? "applied" : "no_op",
      dependsOn: [...operation.dependsOn],
      reasons,
      canonicalRefs: reasons.length ? [] : preparation.refs,
    }),
  };
  preparations.set(prepared, preparation);
  return prepared;
}

function validateNumericPrecision(operation: ContentLinkOperation): void {
  const values =
    operation.kind === "document.entity.link" && operation.confidence !== undefined
      ? [operation.confidence]
      : operation.kind === "summary.materialize"
        ? operation.sources.map((source) => source.weight)
        : operation.kind === "summary.source.link"
          ? [operation.source.weight]
          : [];
  if (values.some((value) => Number(value.toFixed(4)) !== value)) hold("CONTENT_CANONICAL_NUMERIC_PRECISION");
}

/** The caller repeats preparation under its head lock and owns the complete receipt transaction. */
export async function applyPreparedContentOperation(
  context: ContentOperationContext,
  prepared: PreparedContentOperation,
): Promise<ContentLinkOperationResult> {
  const preparation = preparations.get(prepared);
  if (
    !preparation ||
    preparation.context.client !== context.client ||
    preparation.context.tenantId !== context.tenantId ||
    preparation.context.attemptId !== context.attemptId ||
    !context.receiptId
  )
    throw new Error("CONTENT_PREPARATION_TRANSACTION_REQUIRED");
  if (prepared.result.outcome === "held") return prepared.result;
  for (const write of preparation.writes) await context.client.query(write.sql, [...write.values]);
  return prepared.result;
}

function validateEvidence(context: ContentOperationContext, operation: ContentLinkOperation): void {
  if (
    context.evidence.length !== operation.evidence.length ||
    operation.evidence.some(
      (reference) => context.evidence.filter((evidence) => equal(evidence.reference, reference)).length !== 1,
    )
  )
    hold("CONTENT_EVIDENCE_CENSUS_MISMATCH");
  const qualifiers = [...new Set(context.evidence.flatMap((evidence) => [...evidence.qualifiers]))].sort();
  if (!equal([...operation.applicability.qualifiers].sort(), qualifiers)) hold("CONTENT_QUALIFIERS_MISMATCH");
  for (const evidence of context.evidence) {
    if (
      !evidence.eligible ||
      !["pass", "pass_with_warnings"].includes(evidence.policyOutcome) ||
      !isOfficiallyAdmittedVerdict(evidence.verdict) ||
      !evidence.selectedText ||
      sha256Digest(evidence.selectedText) !== evidence.selectedContentDigest
    )
      hold("CONTENT_EVIDENCE_NOT_ADMITTED");
    if (!evidence.downstreamUse.includes(`content_link:${operation.kind}`))
      hold("CONTENT_EVIDENCE_INTENDED_USE_MISMATCH");
    if (requiresEffect(operation) && evidence.value !== contentLinkEffect(operation))
      hold("CONTENT_VERIFIED_EFFECT_MISMATCH");
  }
  if (
    operation.kind !== "chunk.relationship.link" &&
    (operation.applicability.validFrom !== null || operation.applicability.validTo !== null)
  )
    hold("CONTENT_TEMPORAL_AUTHORITY_REQUIRED");
}

function requiresEffect(operation: ContentLinkOperation): boolean {
  // Canonical claim IDs are assigned after sealing. Structural links preserve the admitted fact;
  // semantic enrichment instead requires a pre-sealed effect, including confidence and scope.
  if (operation.kind === "chunk.claim.link") {
    if (!["supports", "challenges", "context"].includes(operation.verb)) hold("CONTENT_LINK_VERB_REQUIRES_EFFECT");
    return false;
  }
  return operation.kind !== "chunk.relationship.link" && operation.kind !== "projection.target.link";
}

async function inspectOperation(preparation: Preparation): Promise<void> {
  const operation = preparation.operation;
  if (
    "chunk" in operation &&
    preparation.context.evidence.some((item) => item.reference.captureId !== operation.chunk.captureId)
  )
    hold("CONTENT_CHUNK_EVIDENCE_CENSUS_MISMATCH");
  switch (preparation.operation.kind) {
    case "document.entity.link":
      return documentEntity(preparation, preparation.operation);
    case "chunk.entity.link":
      return chunkEntity(preparation, preparation.operation);
    case "chunk.claim.link":
      return chunkClaim(preparation, preparation.operation);
    case "chunk.relationship.link":
      return chunkRelationship(preparation, preparation.operation);
    case "summary.materialize":
      return materializeSummary(preparation, preparation.operation);
    case "summary.source.link":
      return summarySource(preparation, preparation.operation);
    case "projection.target.link":
      return projectionTarget(preparation, preparation.operation);
  }
}

async function rows(context: ContentOperationContext, sql: string, values: readonly unknown[]): Promise<Row[]> {
  return (await context.client.query<Row>(sql, [...values])).rows;
}
function reference(
  schema: "content" | "retrieval",
  table: string,
  key: Record<string, string>,
): ContentLinkRowReference {
  return { schema, table, key };
}
async function prepareRow(
  preparation: Preparation,
  input: {
    ref: ContentLinkRowReference;
    select: string;
    selectValues: readonly unknown[];
    expected: Row;
    insert: Write;
  },
): Promise<void> {
  const existing = await rows(preparation.context, input.select, input.selectValues);
  if (existing.length > 1) hold("CONTENT_CANONICAL_IDENTITY_AMBIGUOUS");
  if (
    existing.length &&
    !Object.entries(input.expected).every(([key, value]) => equal(numericValue(existing[0]![key], value), value))
  )
    hold("CONTENT_EXISTING_ROW_CONFLICT");
  if (!existing.length) preparation.writes.push(input.insert);
  preparation.refs.push(input.ref);
}

async function entity(context: ContentOperationContext, entityId: string): Promise<void> {
  const found = await rows(
    context,
    "select id from corpus.entity where tenant_id=$1 and id=$2 and lifecycle='active'",
    [context.tenantId, entityId],
  );
  if (
    found.length !== 1 ||
    !context.evidence.some((evidence) => evidence.entityBindings.some((binding) => binding.canonicalId === entityId))
  )
    hold("CONTENT_ENTITY_BINDING_REQUIRED");
}
function containEvidence(evidence: readonly AuthenticatedContentEvidence[], texts: readonly string[]): void {
  if (
    evidence.some((item) => !texts.some((text) => text.includes(item.selectedText))) ||
    texts.some((text) => !evidence.some((item) => text.includes(item.selectedText)))
  )
    hold("CONTENT_SELECTED_SOURCE_MISMATCH");
}
async function chunk(
  context: ContentOperationContext,
  source: Extract<ContentLinkOperation, { kind: "chunk.claim.link" }>["chunk"],
): Promise<readonly AuthenticatedContentEvidence[]> {
  const loaded = await context.sources.chunk(source);
  const representation = await context.sources.representation(source.representation, source.documentVersionId);
  const evidence = context.evidence.filter(
    (item) =>
      item.reference.captureId === source.captureId &&
      (item.representationArtifactId === representation.artifact_id ||
        item.representationArtifactId === item.captureArtifactId),
  );
  if (!evidence.length) hold("CONTENT_CHUNK_EVIDENCE_REQUIRED");
  if (
    context.evidence.some(
      (item) =>
        item.reference.captureId === source.captureId &&
        item.representationArtifactId !== representation.artifact_id &&
        item.representationArtifactId !== item.captureArtifactId,
    )
  )
    hold("CONTENT_CHUNK_EVIDENCE_CENSUS_MISMATCH");
  containEvidence(evidence, [loaded.text]);
  return evidence;
}
async function nodes(
  context: ContentOperationContext,
  references: readonly { id: string; digest: string; representationId: string }[],
  documentVersionId: string,
): Promise<readonly ContentSourceNode[]> {
  const loaded: ContentSourceNode[] = [];
  for (const source of references) {
    const node = await context.sources.node(source);
    const representation = (
      await rows(
        context,
        "select content_sha256,artifact_id from content.document_representation where tenant_id=$1 and id=$2",
        [context.tenantId, node.representationId],
      )
    )[0];
    if (!representation) hold("CONTENT_NODE_REPRESENTATION_MISSING");
    const matching = context.evidence.filter(
      (item) =>
        (item.representationArtifactId === representation.artifact_id ||
          item.representationArtifactId === item.captureArtifactId) &&
        node.text.includes(item.selectedText),
    );
    if (!matching.length) hold("CONTENT_NODE_EVIDENCE_REQUIRED");
    for (const evidence of matching)
      await context.sources.representationCapture(
        { id: node.representationId, digest: `sha256:${representation.content_sha256}` },
        documentVersionId,
        evidence.reference.captureId,
      );
    loaded.push(node);
  }
  containEvidence(
    context.evidence,
    loaded.map((node) => node.text),
  );
  return loaded;
}

async function documentEntity(
  preparation: Preparation,
  operation: Extract<ContentLinkOperation, { kind: "document.entity.link" }>,
): Promise<void> {
  const context = preparation.context,
    tenantId = context.tenantId;
  await context.sources.documentVersion(operation.documentVersion, operation.documentId);
  await nodes(context, operation.sourceNodes, operation.documentVersion.id);
  await entity(context, operation.entityId);
  await prepareRow(preparation, {
    ref: reference("content", "document_about_entity", {
      tenant_id: tenantId,
      document_id: operation.documentId,
      entity_id: operation.entityId,
    }),
    select:
      "select role,method,confidence from content.document_about_entity where tenant_id=$1 and document_id=$2 and entity_id=$3",
    selectValues: [tenantId, operation.documentId, operation.entityId],
    expected: { role: operation.role, method: operation.method, confidence: operation.confidence ?? null },
    insert: {
      sql: "insert into content.document_about_entity(tenant_id,document_id,entity_id,role,method,confidence) values($1,$2,$3,$4,$5,$6)",
      values: [
        tenantId,
        operation.documentId,
        operation.entityId,
        operation.role,
        operation.method,
        operation.confidence ?? null,
      ],
    },
  });
}

async function chunkEntity(
  preparation: Preparation,
  operation: Extract<ContentLinkOperation, { kind: "chunk.entity.link" }>,
): Promise<void> {
  const context = preparation.context,
    tenantId = context.tenantId;
  await chunk(context, operation.chunk);
  await entity(context, operation.entityId);
  await prepareRow(preparation, {
    ref: reference("retrieval", "chunk_entity_mention", {
      tenant_id: tenantId,
      chunk_id: operation.chunk.id,
      entity_id: operation.entityId,
      verb: operation.verb,
    }),
    select:
      "select method,confidence from retrieval.chunk_entity_mention where tenant_id=$1 and chunk_id=$2 and entity_id=$3 and verb=$4",
    selectValues: [tenantId, operation.chunk.id, operation.entityId, operation.verb],
    expected: { method: operation.method, confidence: operation.confidence ?? null },
    insert: {
      sql: "insert into retrieval.chunk_entity_mention(tenant_id,chunk_id,entity_id,verb,method,confidence) values($1,$2,$3,$4,$5,$6)",
      values: [
        tenantId,
        operation.chunk.id,
        operation.entityId,
        operation.verb,
        operation.method,
        operation.confidence ?? null,
      ],
    },
  });
}

async function chunkClaim(
  preparation: Preparation,
  operation: Extract<ContentLinkOperation, { kind: "chunk.claim.link" }>,
): Promise<void> {
  const context = preparation.context,
    tenantId = context.tenantId;
  await chunk(context, operation.chunk);
  const matching = context.evidence.filter(
    (item) => item.reference.claimId === operation.claimId && item.reference.captureId === operation.chunk.captureId,
  );
  if (!matching.length || !matching.some((item) => item.reference.role === operation.verb))
    hold("CONTENT_CLAIM_ROLE_MISMATCH");
  await prepareRow(preparation, {
    ref: reference("retrieval", "chunk_claim_link", {
      tenant_id: tenantId,
      chunk_id: operation.chunk.id,
      claim_id: operation.claimId,
      verb: operation.verb,
    }),
    select:
      "select claim_id from retrieval.chunk_claim_link where tenant_id=$1 and chunk_id=$2 and claim_id=$3 and verb=$4",
    selectValues: [tenantId, operation.chunk.id, operation.claimId, operation.verb],
    expected: { claim_id: operation.claimId },
    insert: {
      sql: "insert into retrieval.chunk_claim_link(tenant_id,chunk_id,claim_id,verb) values($1,$2,$3,$4)",
      values: [tenantId, operation.chunk.id, operation.claimId, operation.verb],
    },
  });
}

async function chunkRelationship(
  preparation: Preparation,
  operation: Extract<ContentLinkOperation, { kind: "chunk.relationship.link" }>,
): Promise<void> {
  const context = preparation.context,
    tenantId = context.tenantId;
  await chunk(context, operation.chunk);
  const relationship = (
    await rows(context, "select * from corpus.relationship where tenant_id=$1 and id=$2 and k_to is null", [
      tenantId,
      operation.relationshipId,
    ])
  )[0];
  const supporting = context.evidence.filter((item) => item.reference.claimId === relationship?.primary_claim_id);
  if (
    !relationship ||
    !supporting.length ||
    !supporting.some(
      (item) =>
        item.entityBindings.some(
          (binding) => binding.role === "subject" && binding.canonicalId === relationship.from_entity_id,
        ) &&
        item.entityBindings.some(
          (binding) => binding.role === "object" && binding.canonicalId === relationship.to_entity_id,
        ),
    )
  )
    hold("CONTENT_RELATIONSHIP_EVIDENCE_REQUIRED");
  if (relationship.qualifier && !operation.applicability.qualifiers.includes(String(relationship.qualifier)))
    hold("CONTENT_RELATIONSHIP_QUALIFIER_MISMATCH");
  if (operation.verb !== "dates" && !supporting.some((item) => item.reference.role === operation.verb))
    hold("CONTENT_RELATIONSHIP_ROLE_MISMATCH");
  if (operation.verb === "dates" && !supporting.some((item) => item.reference.role === "supports"))
    hold("CONTENT_RELATIONSHIP_ROLE_MISMATCH");
  const temporal = await rows(
    context,
    `select s.primary_claim_id,lower(s.valid_during)::text valid_from,upper(s.valid_during)::text valid_to from temporal.segment s
    join temporal.stream t on t.tenant_id=s.tenant_id and t.id=s.stream_id where t.tenant_id=$1 and t.subject_relationship_id=$2
    and t.kind='relationship_active' and s.k_to is null and s.belief='accepted' and s.status='active' order by lower(s.valid_during) limit 257`,
    [tenantId, operation.relationshipId],
  );
  if (temporal.length) {
    if (
      !temporal.some(
        (row) =>
          supporting.some((item) => item.reference.claimId === row.primary_claim_id) &&
          sameContentInstant(row.valid_from, operation.applicability.validFrom) &&
          sameContentInstant(row.valid_to, operation.applicability.validTo),
      )
    )
      hold("CONTENT_TEMPORAL_AUTHORITY_REQUIRED");
  } else if (
    operation.verb === "dates" ||
    operation.applicability.validFrom !== null ||
    operation.applicability.validTo !== null
  )
    hold("CONTENT_TEMPORAL_AUTHORITY_REQUIRED");
  await prepareRow(preparation, {
    ref: reference("retrieval", "chunk_relationship_evidence", {
      tenant_id: tenantId,
      chunk_id: operation.chunk.id,
      relationship_id: operation.relationshipId,
      verb: operation.verb,
    }),
    select:
      "select relationship_id from retrieval.chunk_relationship_evidence where tenant_id=$1 and chunk_id=$2 and relationship_id=$3 and verb=$4",
    selectValues: [tenantId, operation.chunk.id, operation.relationshipId, operation.verb],
    expected: { relationship_id: operation.relationshipId },
    insert: {
      sql: "insert into retrieval.chunk_relationship_evidence(tenant_id,chunk_id,relationship_id,verb) values($1,$2,$3,$4)",
      values: [tenantId, operation.chunk.id, operation.relationshipId, operation.verb],
    },
  });
}
function numericValue(actual: unknown, expected: unknown): unknown {
  return typeof expected === "number" && actual !== null && actual !== undefined ? Number(actual) : actual;
}

function summaryText(evidence: readonly AuthenticatedContentEvidence[]): string {
  const claims = new Map<string, AuthenticatedContentEvidence>();
  for (const item of evidence) {
    const previous = claims.get(item.reference.claimId);
    if (previous && (previous.statement !== item.statement || !equal(previous.qualifiers, item.qualifiers)))
      hold("CONTENT_SUMMARY_CLAIM_CONFLICT");
    claims.set(item.reference.claimId, item);
  }
  return [...claims.values()].map((item) => [item.statement, ...item.qualifiers].join("\n")).join("\n\n");
}

async function materializeSummary(preparation: Preparation, operation: SummaryOperation): Promise<void> {
  const context = preparation.context,
    tenantId = context.tenantId;
  await context.sources.documentVersion(operation.documentVersion);
  const output = await context.sources.representation(operation.representation, operation.documentVersion.id);
  const input = await context.sources.representation(operation.derivedFrom, operation.documentVersion.id);
  if (
    output.representation_class !== "semantic_projection" ||
    output.representation_kind !== "summary" ||
    output.transformation_run_id !== operation.transformationRunId ||
    !faithfulClasses.has(String(input.representation_class)) ||
    sha256Digest(operation.text) !== operation.representation.digest ||
    summaryText(context.evidence) !== operation.text
  )
    hold("CONTENT_SUMMARY_RENDERING_MISMATCH");
  const transformation = await rows(
    context,
    `select t.id from content.transformation_run t
    join content.transformation_input i on i.tenant_id=t.tenant_id and i.transformation_run_id=t.id and i.representation_id=$3
    join content.transformation_output o on o.tenant_id=t.tenant_id and o.transformation_run_id=t.id and o.representation_id=$4
    where t.tenant_id=$1 and t.id=$2 and t.transformation_kind='summarize' and t.status='succeeded'`,
    [tenantId, operation.transformationRunId, operation.derivedFrom.id, operation.representation.id],
  );
  if (transformation.length !== 1) hold("CONTENT_SUMMARY_TRANSFORMATION_REQUIRED");
  await nodes(context, operation.sources, operation.documentVersion.id);
  if (operation.sources.some((source) => source.representationId !== operation.derivedFrom.id))
    hold("CONTENT_SUMMARY_SOURCE_MISMATCH");
  if (operation.focusEntityId) await entity(context, operation.focusEntityId);
  const count = (
    await rows(
      context,
      "select count(*)::integer count from content.document_node where tenant_id=$1 and representation_id=$2",
      [tenantId, operation.derivedFrom.id],
    )
  )[0];
  if (!count || Number(count.count) < operation.sources.length) hold("CONTENT_SUMMARY_SOURCE_CENSUS_MISMATCH");
  const coverage = Math.round((operation.sources.length / Number(count.count)) * 10000) / 10000;
  await prepareSupersession(preparation, operation);
  const expected = {
    document_version_id: operation.documentVersion.id,
    representation_id: operation.representation.id,
    derived_from_representation_id: operation.derivedFrom.id,
    transformation_run_id: operation.transformationRunId,
    summary_kind: operation.summaryKind,
    scope: operation.scope,
    scope_node_id: operation.scopeNodeId ?? null,
    focus_entity_id: operation.focusEntityId ?? null,
    audience: operation.audience,
    text: operation.text,
    language: operation.language ?? null,
    token_count: operation.tokenCount,
    content_sha256: operation.representation.digest.slice(7),
    coverage_ratio: coverage,
    lifecycle: "active",
    supersedes_id: operation.supersedesId ?? null,
  };
  await prepareRow(preparation, {
    ref: reference("content", "document_summary", { tenant_id: tenantId, id: operation.summaryId }),
    select: "select * from content.document_summary where tenant_id=$1 and id=$2",
    selectValues: [tenantId, operation.summaryId],
    expected,
    insert: {
      sql: `insert into content.document_summary(id,tenant_id,document_version_id,representation_id,derived_from_representation_id,transformation_run_id,
      summary_kind,scope,scope_node_id,focus_entity_id,audience,text,language,token_count,content_sha256,coverage_ratio,lifecycle,supersedes_id)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'active',$17)`,
      values: [
        operation.summaryId,
        tenantId,
        operation.documentVersion.id,
        operation.representation.id,
        operation.derivedFrom.id,
        operation.transformationRunId,
        operation.summaryKind,
        operation.scope,
        operation.scopeNodeId ?? null,
        operation.focusEntityId ?? null,
        operation.audience,
        operation.text,
        operation.language ?? null,
        operation.tokenCount,
        operation.representation.digest.slice(7),
        coverage,
        operation.supersedesId ?? null,
      ],
    },
  });
  for (const source of operation.sources) await prepareSummarySource(preparation, operation.summaryId, source);
}

async function prepareSupersession(preparation: Preparation, operation: SummaryOperation): Promise<void> {
  const context = preparation.context;
  const existing = await rows(
    context,
    `select id from content.document_summary where tenant_id=$1 and document_version_id=$2 and summary_kind=$3
    and scope=$4 and scope_node_id is not distinct from $5::uuid and focus_entity_id is not distinct from $6::uuid and audience=$7 and lifecycle='active'`,
    [
      context.tenantId,
      operation.documentVersion.id,
      operation.summaryKind,
      operation.scope,
      operation.scopeNodeId ?? null,
      operation.focusEntityId ?? null,
      operation.audience,
    ],
  );
  if (existing.some((row) => row.id !== operation.summaryId && row.id !== operation.supersedesId))
    hold("CONTENT_SUMMARY_ACTIVE_CONFLICT");
  if (!operation.supersedesId) return;
  const prior = await loadSummary(context, operation.supersedesId, operation.dependsOn);
  if (
    prior.document_version_id !== operation.documentVersion.id ||
    prior.summary_kind !== operation.summaryKind ||
    prior.scope !== operation.scope ||
    prior.scope_node_id !== (operation.scopeNodeId ?? null) ||
    prior.focus_entity_id !== (operation.focusEntityId ?? null) ||
    prior.audience !== operation.audience ||
    !["active", "superseded"].includes(String(prior.lifecycle))
  )
    hold("CONTENT_SUMMARY_SUPERSESSION_MISMATCH");
  if (prior.lifecycle === "active")
    preparation.writes.push({
      sql: "update content.document_summary set lifecycle='superseded' where tenant_id=$1 and id=$2 and lifecycle='active'",
      values: [context.tenantId, operation.supersedesId],
    });
}

async function loadSummary(
  context: ContentOperationContext,
  summaryId: string,
  dependencies: readonly string[],
): Promise<Row> {
  const existing = (
    await rows(context, "select * from content.document_summary where tenant_id=$1 and id=$2", [
      context.tenantId,
      summaryId,
    ])
  )[0];
  if (existing) {
    await verifySummaryStructure(context, existing);
    return existing;
  }
  for (const dependency of dependencies) {
    const prepared = context.priorPrepared?.get(dependency),
      prior = prepared && preparations.get(prepared);
    if (
      !prior ||
      prior.context.tenantId !== context.tenantId ||
      prior.context.client !== context.client ||
      prepared!.result.outcome === "held" ||
      prior.operation.kind !== "summary.materialize" ||
      prior.operation.summaryId !== summaryId
    )
      continue;
    const operation = prior.operation;
    return {
      id: summaryId,
      document_version_id: operation.documentVersion.id,
      derived_from_representation_id: operation.derivedFrom.id,
      text: operation.text,
      lifecycle: "active",
      summary_kind: operation.summaryKind,
      scope: operation.scope,
      scope_node_id: operation.scopeNodeId ?? null,
      focus_entity_id: operation.focusEntityId ?? null,
      audience: operation.audience,
      content_sha256: operation.representation.digest.slice(7),
      planned_sources: operation.sources,
    };
  }
  return hold("CONTENT_SUMMARY_REQUIRED");
}

async function verifySummaryStructure(context: ContentOperationContext, summary: Row): Promise<void> {
  const output = await context.sources.representation(
    { id: String(summary.representation_id), digest: `sha256:${summary.content_sha256}` },
    String(summary.document_version_id),
  );
  const source = (
    await rows(context, "select content_sha256 from content.document_representation where tenant_id=$1 and id=$2", [
      context.tenantId,
      summary.derived_from_representation_id,
    ])
  )[0];
  if (
    !source ||
    sha256Digest(String(summary.text)) !== `sha256:${summary.content_sha256}` ||
    output.representation_class !== "semantic_projection" ||
    output.representation_kind !== "summary" ||
    output.transformation_run_id !== summary.transformation_run_id
  )
    hold("CONTENT_SUMMARY_LINEAGE_MISMATCH");
  const input = await context.sources.representation(
    { id: String(summary.derived_from_representation_id), digest: `sha256:${source.content_sha256}` },
    String(summary.document_version_id),
  );
  const transformation = await rows(
    context,
    `select t.id from content.transformation_run t
    join content.transformation_input i on i.tenant_id=t.tenant_id and i.transformation_run_id=t.id and i.representation_id=$3
    join content.transformation_output o on o.tenant_id=t.tenant_id and o.transformation_run_id=t.id and o.representation_id=$4
    where t.tenant_id=$1 and t.id=$2 and t.transformation_kind='summarize' and t.status='succeeded'`,
    [
      context.tenantId,
      summary.transformation_run_id,
      summary.derived_from_representation_id,
      summary.representation_id,
    ],
  );
  if (!faithfulClasses.has(String(input.representation_class)) || transformation.length !== 1)
    hold("CONTENT_SUMMARY_TRANSFORMATION_REQUIRED");
}

async function summarySource(
  preparation: Preparation,
  operation: Extract<ContentLinkOperation, { kind: "summary.source.link" }>,
): Promise<void> {
  const context = preparation.context,
    summary = await loadSummary(context, operation.summaryId, operation.dependsOn);
  if (
    summary.lifecycle !== "active" ||
    summary.derived_from_representation_id !== operation.source.representationId ||
    summary.text !== summaryText(context.evidence)
  )
    hold("CONTENT_SUMMARY_SOURCE_MISMATCH");
  await nodes(context, [operation.source], String(summary.document_version_id));
  // Existing immutable summaries cannot silently change their declared coverage ratio.
  const existing = await rows(
    context,
    "select weight from content.document_summary_source where tenant_id=$1 and summary_id=$2 and node_id=$3",
    [context.tenantId, operation.summaryId, operation.source.id],
  );
  const planned = summary.planned_sources as SummaryOperation["sources"] | undefined;
  if (planned?.some((source) => source.id === operation.source.id && source.weight === operation.source.weight)) {
    preparation.refs.push(
      reference("content", "document_summary_source", {
        tenant_id: context.tenantId,
        summary_id: operation.summaryId,
        node_id: operation.source.id,
      }),
    );
    return;
  }
  if (
    !existing.length &&
    !planned?.some((source) => source.id === operation.source.id && source.weight === operation.source.weight) &&
    summary.coverage_ratio !== null
  )
    hold("CONTENT_SUMMARY_SOURCE_REQUIRES_NEW_REVISION");
  await prepareSummarySource(preparation, operation.summaryId, operation.source);
}
async function prepareSummarySource(
  preparation: Preparation,
  summaryId: string,
  source: SummaryOperation["sources"][number],
): Promise<void> {
  const tenantId = preparation.context.tenantId;
  await prepareRow(preparation, {
    ref: reference("content", "document_summary_source", {
      tenant_id: tenantId,
      summary_id: summaryId,
      node_id: source.id,
    }),
    select: "select weight from content.document_summary_source where tenant_id=$1 and summary_id=$2 and node_id=$3",
    selectValues: [tenantId, summaryId, source.id],
    expected: { weight: source.weight },
    insert: {
      sql: "insert into content.document_summary_source(tenant_id,summary_id,node_id,weight) values($1,$2,$3,$4)",
      values: [tenantId, summaryId, source.id, source.weight],
    },
  });
}

async function projectionTarget(
  preparation: Preparation,
  operation: Extract<ContentLinkOperation, { kind: "projection.target.link" }>,
): Promise<void> {
  const context = preparation.context,
    tenantId = context.tenantId;
  const usedEvidence = new Set<AuthenticatedContentEvidence>();
  for (const source of operation.sourceChunks)
    for (const evidence of await chunk(context, source)) usedEvidence.add(evidence);
  if (usedEvidence.size !== context.evidence.length) hold("CONTENT_PROJECTION_EVIDENCE_CENSUS_MISMATCH");
  const { kind, canonicalId } = operation.target;
  switch (kind) {
    case "entity":
      await entity(context, canonicalId);
      await projectionBridges(context, operation, { kind: "entity", id: canonicalId });
      break;
    case "claim":
      if (!context.evidence.some((item) => item.reference.claimId === canonicalId))
        hold("CONTENT_PROJECTION_CLAIM_REQUIRED");
      await projectionBridges(context, operation, { kind: "claim", id: canonicalId });
      break;
    case "record": {
      const record = (
        await rows(
          context,
          `select r.* from knowledge.record r join evidence.claim_record c on c.tenant_id=r.tenant_id and c.record_id=r.id
        and c.claim_id=r.provenance_claim_id where r.tenant_id=$1 and r.id=$2`,
          [tenantId, canonicalId],
        )
      )[0];
      if (
        !record ||
        !context.evidence.some(
          (item) =>
            item.reference.claimId === record.provenance_claim_id &&
            item.statement === record.statement &&
            equal({ qualifiers: item.qualifiers }, record.scope),
        )
      )
        hold("CONTENT_PROJECTION_RECORD_REQUIRED");
      await projectionBridges(context, operation, { kind: "claim", id: String(record.provenance_claim_id) });
      break;
    }
    case "summary": {
      const summary = await loadSummary(context, canonicalId, operation.dependsOn);
      if (summary.lifecycle !== "active" || summary.text !== summaryText(context.evidence))
        hold("CONTENT_PROJECTION_SUMMARY_REQUIRED");
      const planned = summary.planned_sources as SummaryOperation["sources"] | undefined;
      const sourceIds =
        planned?.map((source) => source.id) ??
        (
          await rows(
            context,
            "select node_id from content.document_summary_source where tenant_id=$1 and summary_id=$2 order by node_id limit 257",
            [tenantId, canonicalId],
          )
        ).map((row) => String(row.node_id));
      if (
        !sourceIds.length ||
        sourceIds.length > 256 ||
        operation.sourceChunks.some((source) => !source.sourceNodes.some((node) => sourceIds.includes(node.id))) ||
        sourceIds.some(
          (id) => !operation.sourceChunks.some((source) => source.sourceNodes.some((node) => node.id === id)),
        )
      )
        hold("CONTENT_PROJECTION_SUMMARY_SOURCE_MISMATCH");
      break;
    }
    case "chunk":
      if (!operation.sourceChunks.some((source) => source.id === canonicalId))
        hold("CONTENT_PROJECTION_CHUNK_REQUIRED");
      break;
  }
  const columns = {
    entity_id: kind === "entity" ? canonicalId : null,
    record_id: kind === "record" ? canonicalId : null,
    chunk_id: kind === "chunk" ? canonicalId : null,
    claim_id: kind === "claim" ? canonicalId : null,
    summary_id: kind === "summary" ? canonicalId : null,
  };
  const values = [
    tenantId,
    kind,
    columns.entity_id,
    columns.record_id,
    columns.chunk_id,
    columns.claim_id,
    columns.summary_id,
  ];
  const existing = await rows(
    context,
    `select id,retired_at from retrieval.projection_target where tenant_id=$1 and target_kind=$2
    and entity_id is not distinct from $3::uuid and record_id is not distinct from $4::uuid and chunk_id is not distinct from $5::uuid
    and claim_id is not distinct from $6::uuid and summary_id is not distinct from $7::uuid`,
    values,
  );
  if (existing.length > 1 || existing.some((row) => row.retired_at !== null))
    hold("CONTENT_PROJECTION_TARGET_CONFLICT");
  const id =
    (existing[0]?.id as string | undefined) ??
    deterministicId("content.projection-target", canonicalJson({ tenantId, kind, canonicalId }));
  if (!existing.length)
    preparation.writes.push({
      sql: "insert into retrieval.projection_target(tenant_id,target_kind,entity_id,record_id,chunk_id,claim_id,summary_id,id) values($1,$2,$3,$4,$5,$6,$7,$8)",
      values: [...values, id],
    });
  preparation.refs.push(reference("retrieval", "projection_target", { tenant_id: tenantId, id }));
}

async function projectionBridges(
  context: ContentOperationContext,
  operation: Extract<ContentLinkOperation, { kind: "projection.target.link" }>,
  target: { kind: "entity" | "claim"; id: string },
): Promise<void> {
  for (const source of operation.sourceChunks) {
    const existing =
      target.kind === "entity"
        ? await rows(
            context,
            "select verb from retrieval.chunk_entity_mention where tenant_id=$1 and chunk_id=$2 and entity_id=$3",
            [context.tenantId, source.id, target.id],
          )
        : await rows(
            context,
            "select verb from retrieval.chunk_claim_link where tenant_id=$1 and chunk_id=$2 and claim_id=$3",
            [context.tenantId, source.id, target.id],
          );
    if (existing.length) continue;
    const prior = operation.dependsOn.some((id) => {
      const prepared = context.priorPrepared?.get(id),
        candidate = prepared && preparations.get(prepared);
      if (
        !candidate ||
        candidate.context.client !== context.client ||
        candidate.context.tenantId !== context.tenantId ||
        prepared!.result.outcome === "held"
      )
        return false;
      const proposal = candidate.operation;
      return target.kind === "entity"
        ? proposal.kind === "chunk.entity.link" && proposal.chunk.id === source.id && proposal.entityId === target.id
        : proposal.kind === "chunk.claim.link" && proposal.chunk.id === source.id && proposal.claimId === target.id;
    });
    if (!prior) hold("CONTENT_PROJECTION_SOURCE_BRIDGE_REQUIRED");
  }
}

/** Historical reconciliation checks immutable rows; later evidence eligibility and summary lifecycle may change. */
export async function reconcileContentOperationRefs(
  client: KnowledgeSqlClient,
  input: {
    readonly tenantId: string;
    readonly result: ContentLinkOperationResult;
    readonly operation: ContentLinkOperation;
  },
): Promise<void> {
  const { tenantId, result, operation } = input;
  const mismatch = () => {
    throw new Error("CONTENT_RECEIPT_ROW_MISMATCH");
  };
  if (result.operationId !== operation.operationId || result.kind !== operation.kind) mismatch();
  if (result.outcome === "held") {
    if (result.canonicalRefs.length) mismatch();
    return;
  }
  const expected = immutableRows(operation, tenantId, result.canonicalRefs);
  if (
    expected.length !== result.canonicalRefs.length ||
    new Set(result.canonicalRefs.map((ref) => canonicalJson(ref))).size !== expected.length
  )
    mismatch();
  for (const item of expected) {
    if (!result.canonicalRefs.some((ref) => equal(ref, item.ref))) mismatch();
    const found = (await client.query<Row>(item.select, item.values)).rows;
    if (
      found.length !== 1 ||
      !Object.entries(item.expected).every(([key, value]) => equal(numericValue(found[0]![key], value), value))
    )
      mismatch();
  }
}

interface ImmutableRow {
  ref: ContentLinkRowReference;
  select: string;
  values: unknown[];
  expected: Row;
}
function immutableRows(
  operation: ContentLinkOperation,
  tenantId: string,
  refs: readonly ContentLinkRowReference[],
): ImmutableRow[] {
  switch (operation.kind) {
    case "document.entity.link":
      return [
        {
          ref: reference("content", "document_about_entity", {
            tenant_id: tenantId,
            document_id: operation.documentId,
            entity_id: operation.entityId,
          }),
          select:
            "select role,method,confidence from content.document_about_entity where tenant_id=$1 and document_id=$2 and entity_id=$3",
          values: [tenantId, operation.documentId, operation.entityId],
          expected: { role: operation.role, method: operation.method, confidence: operation.confidence ?? null },
        },
      ];
    case "chunk.entity.link":
      return [
        {
          ref: reference("retrieval", "chunk_entity_mention", {
            tenant_id: tenantId,
            chunk_id: operation.chunk.id,
            entity_id: operation.entityId,
            verb: operation.verb,
          }),
          select:
            "select method,confidence from retrieval.chunk_entity_mention where tenant_id=$1 and chunk_id=$2 and entity_id=$3 and verb=$4",
          values: [tenantId, operation.chunk.id, operation.entityId, operation.verb],
          expected: { method: operation.method, confidence: operation.confidence ?? null },
        },
      ];
    case "chunk.claim.link":
      return [
        {
          ref: reference("retrieval", "chunk_claim_link", {
            tenant_id: tenantId,
            chunk_id: operation.chunk.id,
            claim_id: operation.claimId,
            verb: operation.verb,
          }),
          select:
            "select claim_id from retrieval.chunk_claim_link where tenant_id=$1 and chunk_id=$2 and claim_id=$3 and verb=$4",
          values: [tenantId, operation.chunk.id, operation.claimId, operation.verb],
          expected: { claim_id: operation.claimId },
        },
      ];
    case "chunk.relationship.link":
      return [
        {
          ref: reference("retrieval", "chunk_relationship_evidence", {
            tenant_id: tenantId,
            chunk_id: operation.chunk.id,
            relationship_id: operation.relationshipId,
            verb: operation.verb,
          }),
          select:
            "select relationship_id from retrieval.chunk_relationship_evidence where tenant_id=$1 and chunk_id=$2 and relationship_id=$3 and verb=$4",
          values: [tenantId, operation.chunk.id, operation.relationshipId, operation.verb],
          expected: { relationship_id: operation.relationshipId },
        },
      ];
    case "summary.source.link":
      return [immutableSourceRow(tenantId, operation.summaryId, operation.source)];
    case "summary.materialize":
      return [
        {
          ref: reference("content", "document_summary", { tenant_id: tenantId, id: operation.summaryId }),
          select: "select * from content.document_summary where tenant_id=$1 and id=$2",
          values: [tenantId, operation.summaryId],
          expected: {
            document_version_id: operation.documentVersion.id,
            representation_id: operation.representation.id,
            derived_from_representation_id: operation.derivedFrom.id,
            transformation_run_id: operation.transformationRunId,
            summary_kind: operation.summaryKind,
            scope: operation.scope,
            scope_node_id: operation.scopeNodeId ?? null,
            focus_entity_id: operation.focusEntityId ?? null,
            audience: operation.audience,
            text: operation.text,
            language: operation.language ?? null,
            token_count: operation.tokenCount,
            content_sha256: operation.representation.digest.slice(7),
            supersedes_id: operation.supersedesId ?? null,
          },
        },
        ...operation.sources.map((source) => immutableSourceRow(tenantId, operation.summaryId, source)),
      ];
    case "projection.target.link": {
      const ref = refs[0];
      if (
        !ref ||
        ref.schema !== "retrieval" ||
        ref.table !== "projection_target" ||
        Object.keys(ref.key).sort().join() !== "id,tenant_id" ||
        ref.key.tenant_id !== tenantId ||
        !ref.key.id
      )
        throw new Error("CONTENT_RECEIPT_ROW_MISMATCH");
      const { kind, canonicalId } = operation.target;
      return [
        {
          ref,
          select:
            "select target_kind,entity_id,record_id,chunk_id,claim_id,summary_id from retrieval.projection_target where tenant_id=$1 and id=$2",
          values: [tenantId, ref.key.id],
          expected: {
            target_kind: kind,
            entity_id: kind === "entity" ? canonicalId : null,
            record_id: kind === "record" ? canonicalId : null,
            chunk_id: kind === "chunk" ? canonicalId : null,
            claim_id: kind === "claim" ? canonicalId : null,
            summary_id: kind === "summary" ? canonicalId : null,
          },
        },
      ];
    }
  }
}
function immutableSourceRow(
  tenantId: string,
  summaryId: string,
  source: SummaryOperation["sources"][number],
): ImmutableRow {
  return {
    ref: reference("content", "document_summary_source", {
      tenant_id: tenantId,
      summary_id: summaryId,
      node_id: source.id,
    }),
    select: "select weight from content.document_summary_source where tenant_id=$1 and summary_id=$2 and node_id=$3",
    values: [tenantId, summaryId, source.id],
    expected: { weight: source.weight },
  };
}
