import { ContentLinkIntentSchema, JsonValueSchema, PromotionSelectionSchema, type ContentLinkIntent, type ContentLinkOperation, type PromotionSelection } from "@aiengineer/knowledge-contracts";
import { canonicalJson, sha256Digest } from "@aiengineer/knowledge-core";
import type { TenantSqlClient } from "./postgres.js";
import { operationActorIdentity } from "./actor-identity.js";
import { readContentRepresentationAdmission } from "./content-representation-admission.js";
import { deterministicUuid } from "@aiengineer/knowledge-core";
import { createHash } from "node:crypto";
import type { GovernedProjectionProposal, GovernedProjectionProposalInput } from "./types.js";

type Member = PromotionSelection["selected"][number];
type Source = Member["sourceChunks"][number];
type Row = Record<string, unknown>;
type ProjectionLink = Extract<ContentLinkOperation, { kind: "projection.target.link" }>;
export interface PromotionSelectionArtifact { readonly id: string; readonly digest: string }
export interface PromotionSelectionAuthority {
  readonly tenantId: string; readonly runPinDigest: string; readonly policyDigest: string;
  readonly proposedBy: string; readonly requiredReviewer: string; readonly budget: PromotionSelection["budget"];
}
export interface PromotionSelectionConfiguration {
  readonly selectionAuthority: (client: TenantSqlClient, tenantId: string) => Promise<PromotionSelectionAuthority>;
  readonly selectionPorts: PromotionSelectionPorts;
}
export interface PromotionSelectionReceipt {
  readonly tenantId: string; readonly receiptId: string; readonly intent: ContentLinkIntent;
  readonly operations: readonly { readonly operationId: string; readonly outcome: string;
    readonly canonicalRefs: readonly { readonly schema: string; readonly table: string; readonly key: Readonly<Record<string, string>> }[] }[];
}
export interface PromotionSelectionClaim {
  readonly canonicalClaimId: string; readonly runId: string; readonly claimDigest: string; readonly admissionDigest: string;
  readonly statement: string; readonly qualifiers: readonly string[];
}
/** Host adapters authenticate bytes and existing P3 custody on this exact transaction client. */
export interface PromotionSelectionPorts {
  readArtifact(client: TenantSqlClient, input: { tenantId: string; artifact: PromotionSelectionArtifact }): Promise<Uint8Array>;
  reconcileContentLinkReceipt(client: TenantSqlClient, input: { tenantId: string; receiptId: string }): Promise<PromotionSelectionReceipt>;
  authenticateClaim(client: TenantSqlClient, input: { tenantId: string; policyDigest: string; binding: Member["admittedClaims"][number]; references: ProjectionLink["evidence"] }): Promise<PromotionSelectionClaim>;
  authenticateSource(client: TenantSqlClient, input: { tenantId: string; source: Source; reference: ProjectionLink["sourceChunks"][number] }): Promise<{ text: string; sourceFamilyId: string }>;
  authenticateNode?(client: TenantSqlClient, input: { tenantId: string; reference: ProjectionLink["sourceChunks"][number]["sourceNodes"][number] }): Promise<{ text: string }>;
  measure(input: { text: string; targetSpaces: Member["targetSpaces"] }): Promise<{ tokens: number; costMicros: number }>;
}
export interface ValidatedPromotionMember {
  readonly memberId: string; readonly target: Member["target"]; readonly targetSpaces: Member["targetSpaces"];
  readonly sourceText: string; readonly sourceDigest: string; readonly sourceChunks: Member["sourceChunks"];
  readonly embeddingText: string;
  readonly representations: readonly { readonly id: string; readonly digest: string; readonly decisionId: string }[];
}
export interface ValidatedPromotionSelection {
  readonly selectionDigest: string; readonly artifact: PromotionSelectionArtifact; readonly selection: PromotionSelection;
  readonly members: readonly ValidatedPromotionMember[];
  readonly actual: { readonly bytes: number; readonly tokens: number; readonly costMicros: number };
}
const equal = (a: unknown, b: unknown) => canonicalJson(JsonValueSchema.parse(a)) === canonicalJson(JsonValueSchema.parse(b));
function fail(code: string): never { throw new Error(code); }
const byteDigest = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const count = (value: number) => Number.isSafeInteger(value) && value >= 0;

export async function validatePromotionSelection(client: TenantSqlClient, input: {
  selection: unknown; artifact: PromotionSelectionArtifact; authority: PromotionSelectionAuthority; ports: PromotionSelectionPorts;
}): Promise<ValidatedPromotionSelection> {
  const selection = PromotionSelectionSchema.parse(input.selection), { authority, ports, artifact } = input;
  if (selection.tenantId !== authority.tenantId || selection.runPinDigest !== authority.runPinDigest
    || selection.policyDigest !== authority.policyDigest || selection.proposedBy !== authority.proposedBy
    || selection.requiredReviewer !== authority.requiredReviewer || !equal(selection.budget, authority.budget)) fail("PROMOTION_SELECTION_AUTHORITY_MISMATCH");
  const bytes = await ports.readArtifact(client, { tenantId: authority.tenantId, artifact });
  if (byteDigest(bytes) !== artifact.digest) fail("PROMOTION_SELECTION_ARTIFACT_DIGEST_MISMATCH");
  const parsed = PromotionSelectionSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  if (!equal(parsed, selection)) fail("PROMOTION_SELECTION_ARTIFACT_CONTENT_MISMATCH");
  const state = (await client.query<Row>("select knowledge_seq, clock_timestamp() < $1::timestamptz within_deadline from api.knowledge_head()", [authority.budget.deadline])).rows[0];
  if (!state || Number(state.knowledge_seq) !== selection.expectedKnowledgeHead) fail("PROMOTION_SELECTION_STALE_HEAD");
  if (state.within_deadline !== true) fail("PROMOTION_SELECTION_DEADLINE_EXCEEDED");
  const members: ValidatedPromotionMember[] = [];
  let actualBytes = 0n, tokens = 0n, costMicros = 0n;
  for (const member of selection.selected) {
    const validated = await validateMember(client, selection, member, ports);
    const measured = await ports.measure({ text: validated.embeddingText, targetSpaces: member.targetSpaces });
    if (!count(measured.tokens) || !count(measured.costMicros)) fail("PROMOTION_SELECTION_USAGE_UNKNOWN");
    actualBytes += BigInt(Buffer.byteLength(validated.embeddingText, "utf8"));
    tokens += BigInt(measured.tokens); costMicros += BigInt(measured.costMicros);
    members.push(validated);
  }
  if (members.length > authority.budget.maxMembers || actualBytes > BigInt(authority.budget.maxBytes)
    || tokens > BigInt(authority.budget.maxTokens) || costMicros > BigInt(authority.budget.maxCostMicros)) fail("PROMOTION_SELECTION_BUDGET_EXCEEDED");
  return { selectionDigest: artifact.digest, artifact: { ...artifact }, selection, members,
    actual: { bytes: Number(actualBytes), tokens: Number(tokens), costMicros: Number(costMicros) } };
}

async function validateMember(client: TenantSqlClient, selection: PromotionSelection, member: Member, ports: PromotionSelectionPorts): Promise<ValidatedPromotionMember> {
  const tenantId = selection.tenantId;
  const target = (await client.query<Row>("select * from retrieval.projection_target where tenant_id=$1 and id=$2", [tenantId, member.target.projectionTargetId])).rows[0];
  if (!target || target.target_kind !== member.target.kind || target[`${member.target.kind}_id`] !== member.target.canonicalId
    || target.retired_at !== null) fail("PROMOTION_SELECTION_TARGET_MISMATCH");
  const links: ProjectionLink[] = [];
  for (const receiptId of member.contentLinkReceiptIds) {
    const receipt = await ports.reconcileContentLinkReceipt(client, { tenantId, receiptId });
    if (receipt.tenantId !== tenantId || receipt.receiptId !== receiptId) fail("PROMOTION_SELECTION_RECEIPT_MISMATCH");
    const intent = ContentLinkIntentSchema.parse(receipt.intent);
    if (intent.context.tenantId !== tenantId || intent.contract.policyDigest !== selection.policyDigest) fail("PROMOTION_SELECTION_RECEIPT_POLICY_MISMATCH");
    const matching = intent.operations.filter((operation): operation is ProjectionLink => operation.kind === "projection.target.link"
      && operation.target.kind === member.target.kind && operation.target.canonicalId === member.target.canonicalId
      && receipt.operations.some(result => result.operationId === operation.operationId && ["applied", "no_op"].includes(result.outcome)
        && result.canonicalRefs.some(ref => ref.schema === "retrieval" && ref.table === "projection_target"
          && ref.key.id === member.target.projectionTargetId && ref.key.tenant_id === tenantId)));
    if (!matching.length) fail("PROMOTION_SELECTION_RECEIPT_TARGET_MISSING");
    links.push(...matching);
  }
  const claims: PromotionSelectionClaim[] = [];
  for (const binding of member.admittedClaims) {
    const references = links.flatMap(link => link.evidence).filter(reference => reference.runId === binding.runId
      && reference.claimKey === binding.claimId && reference.claimDigest === binding.claimDigest);
    if (!references.length) fail("PROMOTION_SELECTION_CLAIM_MISMATCH");
    const claim = await ports.authenticateClaim(client, { tenantId, policyDigest: selection.policyDigest, binding, references });
    if (claim.runId !== binding.runId || claim.claimDigest !== binding.claimDigest || claim.admissionDigest !== binding.admissionDigest
      || !links.some(link => link.evidence.some(ref => ref.runId === binding.runId && ref.claimKey === binding.claimId
        && ref.claimId === claim.canonicalClaimId && ref.claimDigest === binding.claimDigest))) fail("PROMOTION_SELECTION_CLAIM_MISMATCH");
    claims.push(claim);
  }
  if (links.some(link => link.evidence.some(ref => !claims.some(claim => claim.canonicalClaimId === ref.claimId
    && claim.runId === ref.runId && claim.claimDigest === ref.claimDigest)))) fail("PROMOTION_SELECTION_CLAIM_CENSUS_MISMATCH");
  if (links.some(link => link.sourceChunks.some(source => !member.sourceChunks.some(item => item.chunkId === source.id)))) fail("PROMOTION_SELECTION_SOURCE_CENSUS_MISMATCH");
  const texts = new Map<string, string>();
  const representations = new Map<string, { id: string; digest: string; decisionId: string }>();
  for (const source of member.sourceChunks) {
    const reference = links.flatMap(link => link.sourceChunks).find(ref => ref.id === source.chunkId && ref.digest === source.chunkDigest
      && ref.captureId === source.captureId && ref.representation.id === source.representationId && ref.representation.digest === source.representationDigest);
    if (!reference) fail("PROMOTION_SELECTION_SOURCE_MISMATCH");
    const authenticated = await ports.authenticateSource(client, { tenantId, source, reference });
    if (sha256Digest(authenticated.text) !== source.chunkDigest || authenticated.sourceFamilyId !== source.sourceFamilyId) fail("PROMOTION_SELECTION_SOURCE_BYTES_MISMATCH");
    const representation = (await client.query<Row>("select representation_class,content_sha256 from content.document_representation where tenant_id=$1 and id=$2", [tenantId, source.representationId])).rows[0];
    if (!representation || representation.representation_class !== source.representationClass || `sha256:${representation.content_sha256}` !== source.representationDigest) fail("PROMOTION_SELECTION_REPRESENTATION_MISMATCH");
    const admission = await readContentRepresentationAdmission(client, { tenantId, representationId: source.representationId, guardedDigest: source.representationDigest });
    if (!admission.accepted || !admission.decisionId) fail("PROMOTION_SELECTION_REPRESENTATION_NOT_ADMITTED");
    representations.set(source.representationId, { id: source.representationId, digest: source.representationDigest, decisionId: admission.decisionId });
    texts.set(source.chunkId, authenticated.text);
  }
  let sourceText: string;
  if (member.content.kind === "node") {
    const reference = links.flatMap(link => link.sourceChunks.flatMap(chunk => chunk.sourceNodes)).find(node => node.id === member.content.id);
    if (!reference || !ports.authenticateNode) fail("PROMOTION_SELECTION_NODE_AUTHORITY_REQUIRED");
    sourceText = (await ports.authenticateNode(client, { tenantId, reference })).text;
  } else {
    const selected = await selectedText(client, tenantId, member, claims, texts, ports);
    sourceText = selected.text;
    if (selected.representation) {
      const existing = representations.get(selected.representation.id);
      if (existing && !equal(existing, selected.representation)) fail("PROMOTION_SELECTION_REPRESENTATION_MISMATCH");
      representations.set(selected.representation.id, selected.representation);
    }
  }
  if (sha256Digest(sourceText) !== member.content.digest) fail("PROMOTION_SELECTION_CONTENT_DIGEST_MISMATCH");
  return { memberId: member.memberId, target: member.target, targetSpaces: member.targetSpaces, sourceText,
    sourceDigest: member.content.digest, sourceChunks: member.sourceChunks, representations: [...representations.values()],
    embeddingText: member.content.kind === "entity" ? [sourceText, ...claims.map(claim => [claim.statement, ...claim.qualifiers].join("\n"))].join("\n\n") : sourceText };
}

async function selectedText(client: TenantSqlClient, tenantId: string, member: Member, claims: PromotionSelectionClaim[], chunks: Map<string, string>, ports: PromotionSelectionPorts): Promise<{
  text: string;
  representation?: { id: string; digest: string; decisionId: string };
}> {
  switch (member.content.kind) {
    case "entity": {
      const row = (await client.query<Row>("select display_name from corpus.entity where tenant_id=$1 and id=$2", [tenantId, member.content.id])).rows[0];
      return { text: typeof row?.display_name === "string" ? row.display_name : fail("PROMOTION_SELECTION_ENTITY_MISSING") };
    }
    case "chunk": return { text: chunks.get(member.content.id) ?? fail("PROMOTION_SELECTION_CONTENT_MISSING") };
    case "claim": {
      const claim = claims.find(claim => claim.canonicalClaimId === member.content.id);
      return { text: claim ? [claim.statement, ...claim.qualifiers].join("\n") : fail("PROMOTION_SELECTION_CONTENT_CLAIM_MISSING") };
    }
    case "record": {
      const row = (await client.query<Row>("select r.* from knowledge.record r join evidence.claim_record c on c.tenant_id=r.tenant_id and c.record_id=r.id and c.claim_id=r.provenance_claim_id where r.tenant_id=$1 and r.id=$2", [tenantId, member.content.id])).rows[0];
      const claim = claims.find(claim => claim.canonicalClaimId === row?.provenance_claim_id && claim.statement === row.statement && equal({ qualifiers: claim.qualifiers }, row.scope));
      return { text: claim ? [claim.statement, ...claim.qualifiers].join("\n") : fail("PROMOTION_SELECTION_RECORD_MISMATCH") };
    }
    case "summary": {
      const row = (await client.query<Row>("select * from content.document_summary where tenant_id=$1 and id=$2", [tenantId, member.content.id])).rows[0];
      const text = claims.map(claim => [claim.statement, ...claim.qualifiers].join("\n")).join("\n\n");
      if (!row || row.lifecycle !== "active" || row.text !== text) fail("PROMOTION_SELECTION_SUMMARY_MISMATCH");
      const representation = (await client.query<Row>("select artifact_id,content_sha256 from content.document_representation where tenant_id=$1 and id=$2", [tenantId, row.representation_id])).rows[0];
      const admission = await readContentRepresentationAdmission(client, { tenantId, representationId: String(row.representation_id), guardedDigest: `sha256:${representation?.content_sha256}` });
      if (!admission.accepted || !admission.decisionId) fail("PROMOTION_SELECTION_SUMMARY_NOT_ADMITTED");
      const bytes = await ports.readArtifact(client, { tenantId, artifact: { id: String(representation?.artifact_id), digest: `sha256:${representation?.content_sha256}` } });
      if (byteDigest(bytes) !== `sha256:${representation?.content_sha256}` || new TextDecoder("utf-8", { fatal: true }).decode(bytes) !== text) fail("PROMOTION_SELECTION_SUMMARY_BYTES_MISMATCH");
      return { text, representation: { id: String(row.representation_id), digest: `sha256:${representation?.content_sha256}`, decisionId: admission.decisionId } };
    }
    default: return fail("PROMOTION_SELECTION_CONTENT_KIND_UNSUPPORTED");
  }
}

/** Exact selected membership is materialized only after all read-side authority checks succeed. */
export async function persistSelectedProjectionProposal(client: TenantSqlClient, tenantId: string,
  input: GovernedProjectionProposalInput, configuration?: PromotionSelectionConfiguration): Promise<GovernedProjectionProposal> {
  if (!configuration || !input.selection || !input.selectionArtifact) fail("PROMOTION_SELECTION_REQUIRED");
  const validated = await validatePromotionSelection(client, { selection: input.selection, artifact: input.selectionArtifact,
    authority: await configuration.selectionAuthority(client, tenantId), ports: configuration.selectionPorts });
  if (validated.selection.tenantId !== tenantId || validated.selection.proposedBy !== input.proposedBy
    || input.contextualPrefix !== "") fail("PROMOTION_SELECTION_PROJECTION_AUTHORITY_MISMATCH");
  const procedure = (await client.query<Row>("select id from retrieval.projection_procedure where id=$1 and implementation_sha256 ~ '^[0-9a-f]{64}$'", [input.projectionProcedureId])).rows[0];
  if (!procedure) fail("PROJECTION_PROCEDURE_NOT_ADMITTED");
  const domains = [...new Set(validated.members.flatMap(member => member.targetSpaces))].sort();
  if (!equal(domains, [...input.targetDomains].sort())) fail("PROMOTION_SELECTION_SPACES_MISMATCH");
  const projections: { memberId: string; projectionId: string; targetId: string; targetSpaces: Member["targetSpaces"]; sourceChunks: Source[]; embeddingDigest: string }[] = [];
  for (const member of validated.members) {
    const embeddingDigest = sha256Digest(member.embeddingText);
    const projectionId = deterministicUuid("selected-search-projection", `${validated.selectionDigest}:${member.memberId}:${input.projectionProcedureId}:${input.purpose}:${embeddingDigest}`);
    const supportManifest = member.sourceChunks.map(source => ({ chunkId: source.chunkId, kind: "faithful_source", sourceDigest: source.chunkDigest }));
    await client.query(`insert into retrieval.search_projection
      (id,tenant_id,projection_target_id,projection_procedure_id,purpose,source_text,contextual_prefix,embedding_text,
       source_text_sha256,contextual_prefix_sha256,embedding_text_sha256,support_manifest,language,content_kind,visibility,classification,promotion_state,generator_identity,prompt_schema_version)
      values($1,$2,$3,$4,$5,$6,'',$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,'candidate',$16,'knowledge.selected-projection/v1') on conflict(id) do nothing`,
    [projectionId,tenantId,member.target.projectionTargetId,input.projectionProcedureId,input.purpose,member.sourceText,member.embeddingText,
      member.sourceDigest.slice(7),sha256Digest("").slice(7),embeddingDigest.slice(7),JSON.stringify(supportManifest),input.language??null,
      member.target.kind,input.visibility,input.classification,input.proposedBy]);
    for (const [ordinal, source] of member.sourceChunks.entries()) await client.query(`insert into retrieval.search_projection_chunk_support
      (tenant_id,search_projection_id,ordinal,chunk_id,support_kind,selected_text_sha256)
      values($1,$2,$3,$4,'faithful_source',$5) on conflict(tenant_id,search_projection_id,ordinal) do nothing`,
    [tenantId,projectionId,ordinal,source.chunkId,source.chunkDigest.slice(7)]);
    const stored = (await client.query<Row>("select * from retrieval.search_projection where tenant_id=$1 and id=$2", [tenantId,projectionId])).rows[0];
    const expected = { projection_target_id: member.target.projectionTargetId, projection_procedure_id: input.projectionProcedureId,
      purpose: input.purpose, source_text: member.sourceText, contextual_prefix: "", embedding_text: member.embeddingText,
      source_text_sha256: member.sourceDigest.slice(7), contextual_prefix_sha256: sha256Digest("").slice(7),
      embedding_text_sha256: embeddingDigest.slice(7), support_manifest: supportManifest, language: input.language??null,
      content_kind: member.target.kind, visibility: input.visibility, classification: input.classification,
      generator_identity: input.proposedBy, prompt_schema_version: "knowledge.selected-projection/v1" };
    if (!stored || !Object.entries(expected).every(([key,value]) => equal(stored[key], value))) fail("SEARCH_PROJECTION_REPLAY_CONFLICT");
    const supports = (await client.query<Row>("select ordinal,chunk_id,selected_text_sha256,support_kind from retrieval.search_projection_chunk_support where tenant_id=$1 and search_projection_id=$2 order by ordinal", [tenantId,projectionId])).rows;
    if (!equal(supports.map(row => ({ ordinal: Number(row.ordinal), chunkId: row.chunk_id, digest: `sha256:${row.selected_text_sha256}`, kind: row.support_kind })),
      member.sourceChunks.map((source,ordinal) => ({ ordinal,chunkId:source.chunkId,digest:source.chunkDigest,kind:"faithful_source" })))) fail("PROJECTION_SUPPORT_REPLAY_CONFLICT");
    projections.push({ memberId:member.memberId,projectionId,targetId:member.target.projectionTargetId,targetSpaces:member.targetSpaces,
      sourceChunks:member.sourceChunks,embeddingDigest });
  }
  const projectionManifestDigest = sha256Digest(JsonValueSchema.parse(projections));
  const document = { chunkSetId:input.chunkSetId,representationId:validated.members[0]!.representations[0]!.id,
    selection:validated.selection,selectionArtifact:validated.artifact,selectionDigest:validated.selectionDigest,
    representations:validated.members.flatMap(member=>member.representations),actual:validated.actual,projections,
    projectionIds:projections.map(row=>row.projectionId),projectionManifestDigest,projectionProcedureId:input.projectionProcedureId,
    targetDomains:domains,expectedValue:input.expectedValue,risks:[...input.risks],exclusions:validated.selection.excluded,reason:input.reason };
  const proposalDigest = sha256Digest(JsonValueSchema.parse(document)), proposalId = deterministicUuid("content-promotion-proposal",`${tenantId}:${proposalDigest}`);
  const proposedBy = await operationActorIdentity({ client, tenantId, operationId: input.operationId, claimedIdentity: input.proposedBy });
  await client.query(`insert into retrieval.content_promotion_proposal
    (id,tenant_id,proposal_sha256,source_manifest,chunk_manifest,projection_manifest,target_domains,expected_value,risks,exclusions,procedures,reason,proposed_by,operation_id)
    values($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11::jsonb,$12,$13,$14) on conflict(id) do nothing`,
  [proposalId,tenantId,proposalDigest.slice(7),JSON.stringify({representations:document.representations}),
    JSON.stringify({sourceChunks:validated.members.flatMap(member=>member.sourceChunks)}),JSON.stringify(document),domains,
    input.expectedValue,input.risks,validated.selection.excluded.map(item=>JSON.stringify(item)),JSON.stringify({projectionProcedureId:input.projectionProcedureId}),input.reason,proposedBy,input.operationId]);
  const stored = (await client.query<Row>("select * from retrieval.content_promotion_proposal where tenant_id=$1 and id=$2",[tenantId,proposalId])).rows[0];
  if (!stored || stored.proposal_sha256 !== proposalDigest.slice(7) || stored.operation_id !== input.operationId
    || stored.proposed_by !== proposedBy || !equal(stored.projection_manifest,document)) fail("PROMOTION_PROPOSAL_REPLAY_CONFLICT");
  return {proposalId,proposalDigest,projectionIds:document.projectionIds,projectionManifestDigest,chunkSetId:input.chunkSetId,
    representationId:document.representationId,selectionDigest:validated.selectionDigest};
}
