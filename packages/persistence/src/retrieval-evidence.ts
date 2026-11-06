import { createHash } from "node:crypto";
import { VerificationSelectorSchema } from "@aiengineer/knowledge-contracts";
import { SupabaseArtifactStore } from "@aiengineer/knowledge-core";
import { digestCanonicalJson, resolveEvidenceSelector } from "@aiengineer/knowledge-verification";
import type { TenantSqlClient } from "./postgres.js";
import { readRepresentationDependencies } from "./representation-dependency.js";

export interface ReadRetrievalArtifact {
  (input: {
    tenantId: string;
    artifactId: string;
    expectedDigest: string;
    maximumBytes: number;
  }): Promise<{ bytes: Uint8Array; mediaType: string }>;
}
export interface RetrievalCitationRequest {
  readonly tenantId: string;
  readonly locatorId: string;
  readonly selectorDigest: string;
  readonly selectedContentDigest: string;
}
export interface ReplayedRetrievalCitation {
  readonly locatorId: string;
  readonly captureId: string;
  readonly sourceFamilyId: string;
  readonly representationArtifactId: string;
  readonly captureArtifactId: string;
  readonly representationDigest: string;
  readonly captureDigest: string;
  readonly selectorDigest: string;
  readonly selectedContentDigest: string;
  readonly selectedText: string;
  readonly selectedSizeBytes: number;
}
type Row = Record<string, unknown>;
const MAX_ARTIFACT_BYTES = 8_000_000;
const MAX_TOTAL_BYTES = 64_000_000;
const MAX_CITATIONS = 128;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = /^sha256:[0-9a-f]{64}$/;
const hash = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** One query's bounded remote-byte cache; callers separately authenticate the canonical claim path. */
export class RetrievalCitationReplay {
  private bytesRemaining = MAX_TOTAL_BYTES;
  private citationsRemaining = MAX_CITATIONS;
  private readonly artifacts = new Map<string, { bytes: Uint8Array; mediaType: string; digest: string }>();

  constructor(
    private readonly client: TenantSqlClient,
    private readonly readArtifact: ReadRetrievalArtifact,
  ) {}

  async replay(input: RetrievalCitationRequest): Promise<ReplayedRetrievalCitation> {
    if (
      !uuid.test(input.tenantId) ||
      !uuid.test(input.locatorId) ||
      !digest.test(input.selectorDigest) ||
      !digest.test(input.selectedContentDigest)
    )
      throw new Error("RETRIEVAL_CITATION_REQUEST_INVALID");
    if (--this.citationsRemaining < 0) throw new Error("RETRIEVAL_CITATION_LIMIT");
    const row = (
      await this.client.query<Row>(
        `select l.*,c.artifact_id capture_artifact_id,c.content_sha256 capture_sha256,
      c.id capture_id,s.id source_family_id
      from evidence.locator l join evidence.source_capture c on c.tenant_id=l.tenant_id and c.id=l.capture_id
      join evidence.source s on s.tenant_id=c.tenant_id and s.id=c.source_id
      where l.tenant_id=$1 and l.id=$2`,
        [input.tenantId, input.locatorId],
      )
    ).rows[0];
    if (
      !row ||
      row.tenant_id !== input.tenantId ||
      row.id !== input.locatorId ||
      row.resolution_state !== "resolved" ||
      !uuid.test(String(row.representation_artifact_id)) ||
      !uuid.test(String(row.capture_id)) ||
      !uuid.test(String(row.source_family_id)) ||
      `sha256:${row.selector_sha256}` !== input.selectorDigest ||
      `sha256:${row.selected_content_sha256}` !== input.selectedContentDigest
    )
      throw new Error("RETRIEVAL_CITATION_BINDING_INVALID");
    const selector = VerificationSelectorSchema.parse(row.selector);
    if (digestCanonicalJson(selector) !== input.selectorDigest) throw new Error("RETRIEVAL_SELECTOR_DIGEST_MISMATCH");
    const capture = await this.artifact(
      input.tenantId,
      String(row.capture_artifact_id),
      `sha256:${row.capture_sha256}`,
    );
    const representation =
      row.representation_artifact_id === row.capture_artifact_id
        ? capture
        : await this.artifact(input.tenantId, String(row.representation_artifact_id));
    const selected = resolveEvidenceSelector({
      captureId: String(row.capture_id),
      representationArtifactId: String(row.representation_artifact_id),
      representationDigest: representation.digest,
      selector,
      content: representation.bytes,
    });
    if (!selected) throw new Error("RETRIEVAL_SELECTOR_UNSUPPORTED");
    if (
      selected.resolution.status !== "resolved" ||
      selected.resolution.selectedContentDigest !== input.selectedContentDigest ||
      selected.selectedContent.byteLength !== Number(row.selected_size_bytes) ||
      selected.resolution.occurrenceCount !== Number(row.occurrence_count) ||
      selected.resolution.normalization !== row.normalization_policy ||
      selected.resolution.resolverVersion !== row.resolution_version
    )
      throw new Error("RETRIEVAL_CITATION_REPLAY_MISMATCH");
    return {
      locatorId: input.locatorId,
      captureId: String(row.capture_id),
      sourceFamilyId: String(row.source_family_id),
      captureArtifactId: String(row.capture_artifact_id),
      representationArtifactId: String(row.representation_artifact_id),
      captureDigest: capture.digest,
      representationDigest: representation.digest,
      selectorDigest: input.selectorDigest,
      selectedContentDigest: input.selectedContentDigest,
      selectedText: new TextDecoder("utf-8", { fatal: true }).decode(selected.selectedContent),
      selectedSizeBytes: selected.selectedContent.byteLength,
    };
  }

  private async artifact(tenantId: string, artifactId: string, expectedDigest?: string) {
    const key = `${tenantId}:${artifactId}`,
      cached = this.artifacts.get(key);
    if (cached) {
      if (expectedDigest && cached.digest !== expectedDigest) throw new Error("RETRIEVAL_ARTIFACT_DIGEST_MISMATCH");
      return cached;
    }
    const metadata = (
      await this.client.query<Row>(
        `select tenant_id,id,sha256,storage_state,size_bytes,media_type
      from orchestration.artifact where tenant_id=$1 and id=$2`,
        [tenantId, artifactId],
      )
    ).rows[0];
    const size = Number(metadata?.size_bytes),
      actualDigest = `sha256:${metadata?.sha256}`;
    if (
      !metadata ||
      metadata.tenant_id !== tenantId ||
      metadata.id !== artifactId ||
      metadata.storage_state !== "available" ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > MAX_ARTIFACT_BYTES ||
      size > this.bytesRemaining ||
      !digest.test(actualDigest) ||
      (expectedDigest !== undefined && expectedDigest !== actualDigest)
    )
      throw new Error("RETRIEVAL_ARTIFACT_UNAVAILABLE");
    this.bytesRemaining -= size;
    const loaded = await this.readArtifact({
      tenantId,
      artifactId,
      expectedDigest: actualDigest,
      maximumBytes: Math.min(size, MAX_ARTIFACT_BYTES),
    });
    if (
      !(loaded.bytes instanceof Uint8Array) ||
      loaded.bytes.byteLength !== size ||
      loaded.mediaType !== metadata.media_type ||
      hash(loaded.bytes) !== actualDigest
    )
      throw new Error("RETRIEVAL_ARTIFACT_BYTES_MISMATCH");
    const result = { bytes: loaded.bytes.slice(), mediaType: loaded.mediaType, digest: actualDigest };
    this.artifacts.set(key, result);
    return result;
  }
}

// Support traversal shapes and bounds are owned by the application retrieval port.
export {
  RETRIEVAL_SUPPORT_LIMITS,
  type ResolvedRetrievalSupport,
  type RetrievalSupportPathRow,
  type RetrievalSupportRequest,
  type RetrievalTargetKind,
} from "@aiengineer/knowledge-application";
import {
  RETRIEVAL_SUPPORT_LIMITS,
  type ResolvedRetrievalSupport,
  type RetrievalSupportPathRow,
  type RetrievalSupportRequest,
  type RetrievalTargetKind,
} from "@aiengineer/knowledge-application";

const TARGET_COLUMNS: ReadonlyMap<RetrievalTargetKind, string> = new Map([
  ["entity", "entity_id"],
  ["record", "record_id"],
  ["chunk", "chunk_id"],
  ["claim", "claim_id"],
  ["summary", "summary_id"],
]);
const ADMISSIBLE_VERDICTS = ["directly_supported", "supported_with_qualification", "derived_verified"];

/**
 * Resolves the canonical target, admitted claims, assessments, locators, captures and
 * source families behind retrieval candidates at one knowledge sequence.
 *
 * The traversal reads canonical rows only. A projection support manifest is a pointer and
 * is never trusted: admission is rechecked through `retrieval.history_claim_authorized`
 * and the representation review through `retrieval.history_representation_authorized`, so
 * a revoked dependency removes the path instead of degrading it. Candidate, row and byte
 * limits bound one query; exceeding the per-candidate path limit marks that member
 * truncated rather than inventing an unbounded closure.
 */
export class RetrievalSupportResolver {
  constructor(private readonly client: TenantSqlClient) {}

  async resolve(input: RetrievalSupportRequest): Promise<readonly ResolvedRetrievalSupport[]> {
    if (
      !uuid.test(input.tenantId) ||
      !Number.isSafeInteger(input.knowledgeSeq) ||
      input.knowledgeSeq < 0 ||
      input.vectorItemIds.length > RETRIEVAL_SUPPORT_LIMITS.maximumCandidates ||
      new Set(input.vectorItemIds).size !== input.vectorItemIds.length ||
      input.vectorItemIds.some((id) => !uuid.test(id))
    )
      throw new Error("RETRIEVAL_SUPPORT_REQUEST_INVALID");
    if (!input.vectorItemIds.length) return [];
    const targets = await this.targets(input);
    if (!targets.size) return [];
    const rows = await this.supportRows(input);
    if (rows.length > RETRIEVAL_SUPPORT_LIMITS.maximumRows) throw new Error("RETRIEVAL_SUPPORT_ROW_LIMIT");
    const { contradictions, supersessions } = await this.claimState(
      input.tenantId,
      [...new Set(rows.map((row) => String(row.claim_id)))],
      input.knowledgeSeq,
    );
    const byCandidate = new Map<string, RetrievalSupportPathRow[]>();
    const truncated = new Set<string>();
    let captureBytes = 0;
    const eligibleRepresentations = new Map<string, boolean>();
    for (const row of rows) {
      const representationId = String(row.representation_id);
      if (!eligibleRepresentations.has(representationId))
        eligibleRepresentations.set(
          representationId,
          (await readRepresentationDependencies(this.client, input.tenantId, representationId)).eligible,
        );
      if (!eligibleRepresentations.get(representationId)) continue;
      const vectorItemId = String(row.vector_item_id);
      const paths = byCandidate.get(vectorItemId) ?? [];
      if (paths.length >= RETRIEVAL_SUPPORT_LIMITS.maximumPathsPerCandidate) {
        truncated.add(vectorItemId);
        continue;
      }
      const path = supportPath(input.tenantId, row);
      captureBytes += path.captureArtifact.byteLength;
      if (captureBytes > RETRIEVAL_SUPPORT_LIMITS.maximumCaptureBytes) throw new Error("RETRIEVAL_SUPPORT_BYTE_LIMIT");
      paths.push(path);
      byCandidate.set(vectorItemId, paths);
    }
    return [...targets.entries()].flatMap(([vectorItemId, target]) => {
      const paths = byCandidate.get(vectorItemId) ?? [];
      if (!paths.length) return [];
      return [
        {
          vectorItemId,
          searchProjectionId: target.searchProjectionId,
          target: { kind: target.kind, canonicalId: target.canonicalId, projectionTargetId: target.projectionTargetId },
          paths,
          sourceFamilyIds: [...new Set(paths.map((path) => path.sourceFamilyId))].sort(),
          graphPaths: paths.map((path) => [
            `projection_target:${target.projectionTargetId}`,
            `claim:${path.claimId}`,
            `locator:${path.locatorId}`,
            `capture:${path.captureId}`,
            `source:${path.sourceFamilyId}`,
          ]),
          contradictionIds: [...new Set(paths.flatMap((path) => contradictions.get(path.claimId) ?? []))].sort(),
          supersedesIds: [...new Set(paths.flatMap((path) => supersessions.get(path.claimId) ?? []))].sort(),
          truncated: truncated.has(vectorItemId),
        },
      ];
    });
  }

  private async targets(input: RetrievalSupportRequest) {
    const rows = (
      await this.client.query<Row>(
        `select vi.id vector_item_id,vi.search_projection_id,pt.id projection_target_id,
        pt.target_kind,pt.entity_id,pt.record_id,pt.chunk_id,pt.claim_id,pt.summary_id,summary.representation_id summary_representation_id
      from retrieval.vector_item vi
      join retrieval.search_projection sp on sp.tenant_id=vi.tenant_id and sp.id=vi.search_projection_id
      join retrieval.projection_target pt on pt.tenant_id=sp.tenant_id and pt.id=sp.projection_target_id
        and pt.id=vi.projection_target_id and pt.retired_at is null
      left join content.document_summary summary on summary.tenant_id=pt.tenant_id and summary.id=pt.summary_id
      where vi.tenant_id=$1 and vi.id=any($2::uuid[]) and vi.lifecycle='active'
      order by array_position($2::uuid[],vi.id)`,
        [input.tenantId, input.vectorItemIds],
      )
    ).rows;
    const targets = new Map<
      string,
      { searchProjectionId: string; kind: RetrievalTargetKind; canonicalId: string; projectionTargetId: string }
    >();
    for (const row of rows) {
      if (
        typeof row.summary_representation_id === "string" &&
        !(await readRepresentationDependencies(this.client, input.tenantId, row.summary_representation_id)).eligible
      )
        continue;
      const kind = String(row.target_kind) as RetrievalTargetKind;
      const column = TARGET_COLUMNS.get(kind);
      const canonicalId = column === undefined ? undefined : row[column];
      if (typeof canonicalId !== "string" || !uuid.test(canonicalId))
        throw new Error("RETRIEVAL_TARGET_IDENTITY_INVALID");
      targets.set(String(row.vector_item_id), {
        searchProjectionId: String(row.search_projection_id),
        kind,
        canonicalId,
        projectionTargetId: String(row.projection_target_id),
      });
    }
    return targets;
  }

  /** One bounded traversal: projection support, chunk, admitted claim and its verdict, locator, capture, source. */
  private async supportRows(input: RetrievalSupportRequest) {
    const admissionPath = "'{verification,admission,run,runId}'";
    const auditPath = "'{verification,admission,run,auditDigest}'";
    const qualifierPath = "'{verification,qualifiers}'";
    // The per-link legacy assessment (evidence.claim_evidence_assessment) was withdrawn by AIDB 0.5.0; the claim's
    // admitted verification verdict is the support verdict and history_claim_authorized requires admitted exact use.
    const verdictPath = "'{verification,verdict}'";
    return (
      await this.client.query<Row>(
        `select vi.id vector_item_id,c.id claim_id,c.status::text claim_status,
        c.structured #>> ${admissionPath} verification_run_id,
        c.structured #>> ${auditPath} admission_digest,
        coalesce(c.structured #> ${qualifierPath},'[]'::jsonb) qualifiers,
        c.structured #>> ${verdictPath} assessment_verdict,loc.id locator_id,loc.selector_sha256,loc.selected_content_sha256,
        cap.id capture_id,src.id source_family_id,cs.representation_id,
        ca.id capture_artifact_id,ca.sha256 capture_artifact_sha256,ca.media_type capture_media_type,ca.size_bytes capture_size_bytes
      from retrieval.vector_item vi
      join retrieval.search_projection_chunk_support s on s.tenant_id=vi.tenant_id and s.search_projection_id=vi.search_projection_id
      join retrieval.retrieval_chunk rc on rc.tenant_id=s.tenant_id and rc.id=s.chunk_id and rc.lifecycle='active'
      join retrieval.chunk_set cs on cs.tenant_id=rc.tenant_id and cs.id=rc.chunk_set_id and cs.status='succeeded'
      join retrieval.chunk_claim_link cc on cc.tenant_id=rc.tenant_id and cc.chunk_id=rc.id and cc.verb='supports'
      join evidence.claim c on c.tenant_id=cc.tenant_id and c.id=cc.claim_id
      join evidence.claim_evidence_link l on l.tenant_id=c.tenant_id and l.claim_id=c.id and l.role='supports'
      join evidence.locator loc on loc.tenant_id=l.tenant_id and loc.id=l.locator_id and loc.resolution_state='resolved'
      join evidence.source_capture cap on cap.tenant_id=loc.tenant_id and cap.id=loc.capture_id
      join evidence.source src on src.tenant_id=cap.tenant_id and src.id=cap.source_id
      join orchestration.artifact ca on ca.tenant_id=cap.tenant_id and ca.id=cap.artifact_id
        and ca.storage_state='available' and ca.sha256=cap.content_sha256
      where vi.tenant_id=$1 and vi.id=any($2::uuid[]) and vi.lifecycle='active'
        and c.structured #>> ${verdictPath}=any($4::text[])
        and retrieval.history_representation_authorized(cs.representation_id)
        and retrieval.history_claim_authorized(c.id)
        and coalesce(retrieval.history_receipt_k(c.created_by_receipt_id),$3::bigint+1)<=$3::bigint
      order by array_position($2::uuid[],vi.id),c.id,loc.id
      limit ${RETRIEVAL_SUPPORT_LIMITS.maximumRows + 1}`,
        [input.tenantId, input.vectorItemIds, input.knowledgeSeq, ADMISSIBLE_VERDICTS],
      )
    ).rows;
  }

  private async claimState(tenantId: string, claimIds: readonly string[], knowledgeSeq: number) {
    const contradictions = new Map<string, string[]>(),
      supersessions = new Map<string, string[]>();
    if (!claimIds.length) return { contradictions, supersessions };
    const conflicts = (
      await this.client.query<Row>(
        `select k.claim_a_id,k.claim_b_id from evidence.claim_conflict k
      join evidence.claim a on a.tenant_id=$1 and a.id=k.claim_a_id
      join evidence.claim b on b.tenant_id=$1 and b.id=k.claim_b_id
      where (k.claim_a_id=any($2::uuid[]) or k.claim_b_id=any($2::uuid[]))
        and k.conflict_kind='contradiction'
        and $3=(select knowledge_seq from temporal.knowledge_head where tenant_id=$1)
        and retrieval.history_claim_authorized(a.id) and retrieval.history_claim_authorized(b.id)
        and retrieval.history_receipt_k(a.created_by_receipt_id)<=$3
        and retrieval.history_receipt_k(b.created_by_receipt_id)<=$3
      limit ${RETRIEVAL_SUPPORT_LIMITS.maximumRows + 1}`,
        [tenantId, claimIds, knowledgeSeq],
      )
    ).rows;
    if (conflicts.length > RETRIEVAL_SUPPORT_LIMITS.maximumRows) throw new Error("RETRIEVAL_CLAIM_STATE_ROW_LIMIT");
    for (const row of conflicts) {
      append(contradictions, String(row.claim_a_id), String(row.claim_b_id));
      append(contradictions, String(row.claim_b_id), String(row.claim_a_id));
    }
    const lineage = (
      await this.client.query<Row>(
        `select c.id claim_id,older.id older_id
      from evidence.claim c
      join evidence.claim older on older.tenant_id=c.tenant_id and older.superseded_by_id=c.id
      where c.tenant_id=$1 and c.id=any($2::uuid[])
        and $3=(select knowledge_seq from temporal.knowledge_head where tenant_id=$1)
        and retrieval.history_claim_authorized(c.id) and retrieval.history_claim_authorized(older.id)
        and retrieval.history_receipt_k(c.created_by_receipt_id)<=$3
        and retrieval.history_receipt_k(older.created_by_receipt_id)<=$3
      limit ${RETRIEVAL_SUPPORT_LIMITS.maximumRows + 1}`,
        [tenantId, claimIds, knowledgeSeq],
      )
    ).rows;
    if (lineage.length > RETRIEVAL_SUPPORT_LIMITS.maximumRows) throw new Error("RETRIEVAL_CLAIM_STATE_ROW_LIMIT");
    for (const row of lineage) {
      if (row.older_id) append(supersessions, String(row.claim_id), String(row.older_id));
    }
    const temporal = (
      await this.client.query<Row>(
        `select 'supersedes' relation,newer.primary_claim_id claim_id,older.primary_claim_id other_claim_id
      from temporal.segment newer
      join temporal.segment older on older.tenant_id=newer.tenant_id and older.id=newer.replaces_segment_id
        and older.stream_id=newer.stream_id and older.k_to=newer.k_from
      join evidence.claim newer_claim on newer_claim.tenant_id=newer.tenant_id and newer_claim.id=newer.primary_claim_id
      join evidence.claim older_claim on older_claim.tenant_id=older.tenant_id and older_claim.id=older.primary_claim_id
      where newer.tenant_id=$1 and newer.primary_claim_id=any($2::uuid[])
        and newer.primary_claim_id<>older.primary_claim_id and newer.belief='accepted' and older.belief='accepted'
        and newer.valid_during && older.valid_during
        and newer.k_from<=$3 and (newer.k_to is null or newer.k_to>$3)
        and retrieval.history_receipt_k(newer_claim.created_by_receipt_id)<=$3
        and retrieval.history_receipt_k(older_claim.created_by_receipt_id)<=$3
        and retrieval.history_claim_authorized(newer.primary_claim_id)
        and retrieval.history_claim_authorized(older.primary_claim_id)
      union all
      select 'challenges',support.claim_id,coalesce(segment.primary_claim_id,occurrence.primary_claim_id)
      from evidence.segment_support support
      left join temporal.segment segment on segment.tenant_id=support.tenant_id and segment.id=support.segment_id
        and segment.belief='accepted' and segment.k_from<=$3 and (segment.k_to is null or segment.k_to>$3)
      left join temporal.event_occurrence occurrence on occurrence.tenant_id=support.tenant_id and occurrence.id=support.event_occurrence_id
        and occurrence.belief='accepted' and occurrence.k_from<=$3 and (occurrence.k_to is null or occurrence.k_to>$3)
      join evidence.claim challenger on challenger.tenant_id=support.tenant_id and challenger.id=support.claim_id
      join evidence.claim challenged on challenged.tenant_id=support.tenant_id and challenged.id=coalesce(segment.primary_claim_id,occurrence.primary_claim_id)
      where support.tenant_id=$1 and support.role='challenges' and support.k_from<=$3 and (support.k_to is null or support.k_to>$3)
        and (support.claim_id=any($2::uuid[]) or coalesce(segment.primary_claim_id,occurrence.primary_claim_id)=any($2::uuid[]))
        and support.claim_id<>coalesce(segment.primary_claim_id,occurrence.primary_claim_id)
        and retrieval.history_receipt_k(challenger.created_by_receipt_id)<=$3
        and retrieval.history_receipt_k(challenged.created_by_receipt_id)<=$3
        and retrieval.history_claim_authorized(support.claim_id)
        and retrieval.history_claim_authorized(coalesce(segment.primary_claim_id,occurrence.primary_claim_id))
      limit ${RETRIEVAL_SUPPORT_LIMITS.maximumRows + 1}`,
        [tenantId, claimIds, knowledgeSeq],
      )
    ).rows;
    if (temporal.length > RETRIEVAL_SUPPORT_LIMITS.maximumRows) throw new Error("RETRIEVAL_CLAIM_STATE_ROW_LIMIT");
    for (const row of temporal) {
      if (row.relation === "supersedes") append(supersessions, String(row.claim_id), String(row.other_claim_id));
      if (row.relation === "challenges") {
        append(contradictions, String(row.claim_id), String(row.other_claim_id));
        append(contradictions, String(row.other_claim_id), String(row.claim_id));
      }
    }
    return { contradictions, supersessions };
  }
}

function append(index: Map<string, string[]>, key: string, value: string): void {
  const current = index.get(key);
  if (!current) {
    index.set(key, [value]);
    return;
  }
  if (!current.includes(value)) current.push(value);
}

function supportPath(tenantId: string, row: Row): RetrievalSupportPathRow {
  const admissionDigest = String(row.admission_digest);
  const selectorDigest = `sha256:${String(row.selector_sha256)}`;
  const selectedContentDigest = `sha256:${String(row.selected_content_sha256)}`;
  const captureDigest = `sha256:${String(row.capture_artifact_sha256)}`;
  const status = String(row.claim_status),
    verdict = String(row.assessment_verdict);
  const byteLength = Number(row.capture_size_bytes);
  const qualifiers = Array.isArray(row.qualifiers)
    ? row.qualifiers.filter((value): value is string => typeof value === "string")
    : [];
  if (
    !digest.test(admissionDigest) ||
    !digest.test(selectorDigest) ||
    !digest.test(selectedContentDigest) ||
    !digest.test(captureDigest) ||
    !uuid.test(String(row.verification_run_id)) ||
    !uuid.test(String(row.locator_id)) ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0 ||
    !["verified", "superseded"].includes(status) ||
    !ADMISSIBLE_VERDICTS.includes(verdict)
  )
    throw new Error("RETRIEVAL_SUPPORT_BINDING_INVALID");
  return {
    claimId: String(row.claim_id),
    claimStatus: status as "verified" | "superseded",
    verificationRunId: String(row.verification_run_id),
    assessmentVerdict: verdict as RetrievalSupportPathRow["assessmentVerdict"],
    admissionDigest: admissionDigest as `sha256:${string}`,
    locatorId: String(row.locator_id),
    selectorDigest: selectorDigest as `sha256:${string}`,
    selectedContentDigest: selectedContentDigest as `sha256:${string}`,
    captureId: String(row.capture_id),
    sourceFamilyId: String(row.source_family_id),
    representationId: String(row.representation_id),
    captureArtifact: {
      artifactId: String(row.capture_artifact_id),
      tenantId,
      digest: captureDigest as `sha256:${string}`,
      mediaType: String(row.capture_media_type),
      byteLength,
    },
    qualifiers,
  };
}

/** Smallest database surface the remote citation reader needs. */
export interface RetrievalArtifactCatalog {
  transaction<T>(tenantId: string, work: (client: TenantSqlClient) => Promise<T>): Promise<T>;
}

export interface RemoteRetrievalArtifactReaderConfig {
  readonly projectUrl: string;
  readonly serviceRoleKey: string;
  /** Buckets this deployment may read citation bytes from. Anything else is denied. */
  readonly buckets: readonly string[];
  readonly maximumBytes?: number;
}

/**
 * Reads citation bytes from remote object custody, never from producer scratch state.
 *
 * The canonical row decides which bucket and media type are admissible; the store then
 * re-derives the digest from the fetched bytes, so a missing object, a foreign bucket or
 * altered bytes fail instead of resolving.
 */
export function createRemoteRetrievalArtifactReader(
  database: RetrievalArtifactCatalog,
  config: RemoteRetrievalArtifactReaderConfig,
): ReadRetrievalArtifact {
  if (!config.buckets.length || new Set(config.buckets).size !== config.buckets.length)
    throw new Error("RETRIEVAL_ARTIFACT_BUCKETS_INVALID");
  const maximumBytes = config.maximumBytes ?? MAX_ARTIFACT_BYTES;
  const stores = new Map(
    config.buckets.map((bucket) => [
      bucket,
      new SupabaseArtifactStore({
        projectUrl: config.projectUrl,
        serviceRoleKey: config.serviceRoleKey,
        bucket,
        maximumBytes,
      }),
    ]),
  );
  return async (input) => {
    if (!uuid.test(input.tenantId) || !uuid.test(input.artifactId) || !digest.test(input.expectedDigest))
      throw new Error("RETRIEVAL_ARTIFACT_REQUEST_INVALID");
    const row = await database.transaction(
      input.tenantId,
      async (client) =>
        (
          await client.query<Row>(
            `select storage_bucket,media_type,size_bytes,sha256,storage_state
       from orchestration.artifact where tenant_id=$1 and id=$2`,
            [input.tenantId, input.artifactId],
          )
        ).rows[0],
    );
    if (!row || row.storage_state !== "available" || `sha256:${String(row.sha256)}` !== input.expectedDigest)
      throw new Error("RETRIEVAL_ARTIFACT_UNAVAILABLE");
    const store = stores.get(String(row.storage_bucket));
    if (!store) throw new Error("RETRIEVAL_ARTIFACT_BUCKET_DENIED");
    const bytes = await store.get(input.tenantId, input.expectedDigest as `sha256:${string}`);
    if (!bytes) throw new Error("RETRIEVAL_ARTIFACT_OBJECT_MISSING");
    if (bytes.byteLength > Math.min(maximumBytes, input.maximumBytes)) throw new Error("RETRIEVAL_ARTIFACT_BYTE_LIMIT");
    return { bytes, mediaType: String(row.media_type) };
  };
}
