import { canonicalJson } from "../db-read/index.js";
import type { KnowledgeSqlClient } from "../ports.js";
import { domainError } from "../schema-workspace/index.js";
import { isOfficiallyAdmittedVerdict, type AuthoritativeClaim } from "./evidence-admission.js";
import { deterministicId } from "./plan.js";
import type { AffectedRef } from "./receipt.js";

export { isOfficiallyAdmittedVerdict };

type Provenance = NonNullable<AuthoritativeClaim["provenance"]>;
type Evidence = Provenance["evidence"][number];
type Row = Record<string, unknown>;
interface Context {
  client: KnowledgeSqlClient;
  tenantId: string;
  claimRowId: string;
}
const METHOD_ALIASES: Readonly<Record<string, string>> = {
  "direct-http": "http",
  "firecrawl-scrape": "firecrawl",
  "manual-upload": "manual",
  "repository-archive": "repository",
  "paper-resolver": "api",
  https_acquire: "http",
  registered_artifact: "manual",
  file_text: "manual",
  file_html: "manual",
  firecrawl_parse: "firecrawl",
  https_get: "http",
  "https_get+firecrawl_parse": "http",
};
const SOURCE_CLASSES = new Set(["web_page", "api", "repository", "pdf", "transcript", "dataset", "registry", "other"]);

export function canonicalCaptureMethod(originalMethod: string): string {
  const adapter = originalMethod.split("@", 1)[0]!;
  return METHOD_ALIASES[adapter] ?? adapter;
}

/** All records are written in the ingestion transaction, from the host's authenticated sealed bytes. */
export async function materializeProvenance(
  context: Context,
  claim: AuthoritativeClaim,
): Promise<{ locatorIds: string[]; affected: AffectedRef[] }> {
  const provenance = claim.provenance;
  if (!provenance || provenance.tenantId !== context.tenantId || !provenance.evidence.length)
    throw domainError(
      "AUTHORITATIVE_PROVENANCE_REQUIRED",
      "Canonical claims require authenticated source and admission lineage",
    );
  await requireArtifacts(context, [
    provenance.auditArtifactId,
    provenance.policyArtifactId,
    provenance.decisionArtifactId,
  ]);
  const affected: AffectedRef[] = [];
  const locatorIds: string[] = [];
  await verifyRunPrincipals(context, claim);
  for (const edge of provenance.evidence) {
    await requireArtifacts(context, [
      edge.capture.artifactId,
      edge.representationArtifactId,
      ...edge.parserLineageArtifactIds,
    ]);
    const sourceId = await source(context, edge, affected);
    const captureId = await capture(context, { edge, sourceId }, affected);
    const locatorId = await locator(context, { edge, captureId }, affected);
    const linkId = deterministicId(
      "evidence.claim_evidence_link",
      canonicalJson([context.tenantId, context.claimRowId, locatorId, edge.role]),
    );
    await insertImmutable(
      context,
      {
        table: "claim_evidence_link",
        id: linkId,
        columns: {
          tenant_id: context.tenantId,
          verification_contract_version: "verification.v1",
          claim_id: context.claimRowId,
          locator_id: locatorId,
          role: edge.role,
          authority_assessment: edge.authority,
        },
      },
      affected,
    );
    locatorIds.push(locatorId);
  }
  await promoteOfficialClaimStatus(context.client, {
    tenantId: context.tenantId,
    claimRowId: context.claimRowId,
    verdict: claim.verdict,
  });
  return { locatorIds: [...new Set(locatorIds)], affected };
}

/** Flips `evidence.claim.status` to verified only for policy-admitted official verdicts. */
export async function promoteOfficialClaimStatus(
  client: KnowledgeSqlClient,
  input: { tenantId: string; claimRowId: string; verdict: string },
): Promise<boolean> {
  if (!isOfficiallyAdmittedVerdict(input.verdict)) return false;
  await client.query("update evidence.claim set status='verified' where tenant_id=$1 and id=$2", [
    input.tenantId,
    input.claimRowId,
  ]);
  return true;
}

/**
 * Checks the sealed run's principals and custody. The run, its findings and per-link assessments are component
 * records (knowledge_verification); AIDB 0.5.0 withdrew evidence.verification_run, verification_finding and
 * claim_evidence_assessment, so no AIDB copy is written here.
 */
async function verifyRunPrincipals(context: Context, claim: AuthoritativeClaim): Promise<void> {
  const provenance = claim.provenance!;
  const run = provenance.run;
  if (
    ![run.runId, run.producerAttemptId, run.verifierAttemptId].every((id) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),
    )
  )
    throw domainError(
      "CANONICAL_VERIFICATION_CONTEXT_REQUIRED",
      "Canonical ingestion requires a UUID run and host-bound producer/verifier attempts",
    );
  const attempts = (
    await context.client.query<Row>(
      "select id,agent_deployment_id from orchestration.attempt where tenant_id=$1 and id=any($2::uuid[])",
      [context.tenantId, [run.producerAttemptId, run.verifierAttemptId]],
    )
  ).rows;
  if (
    run.producerDeploymentId === run.verifierDeploymentId ||
    !attempts.some((row) => row.id === run.producerAttemptId && row.agent_deployment_id === run.producerDeploymentId) ||
    !attempts.some((row) => row.id === run.verifierAttemptId && row.agent_deployment_id === run.verifierDeploymentId)
  )
    throw domainError(
      "VERIFICATION_PRINCIPAL_BINDING_MISMATCH",
      "Sealed verification actors must match distinct same-tenant registered attempts",
    );
  await requireArtifacts(context, [run.bundleArtifactId, run.resultArtifactId]);
}

async function requireArtifacts(context: Context, ids: readonly string[]): Promise<void> {
  const rows = await context.client.query<Row>(
    "select id from orchestration.artifact where tenant_id=$1 and id=any($2::uuid[]) and storage_state='available'",
    [context.tenantId, [...new Set(ids)]],
  );
  if (rows.rows.length !== new Set(ids).size)
    throw domainError(
      "PROVENANCE_ARTIFACT_UNAVAILABLE",
      "Authoritative provenance artifacts must be available in durable custody",
    );
}

async function source(context: Context, edge: Evidence, affected: AffectedRef[]): Promise<string> {
  const id = deterministicId("evidence.source", canonicalJson([context.tenantId, edge.source.canonicalUri]));
  const sourceClass = SOURCE_CLASSES.has(edge.source.kind) ? edge.source.kind : "other";
  const inserted = (
    await context.client.query<Row>(
      "insert into evidence.source(id,tenant_id,source_class,canonical_url) values($1,$2,$3,$4) on conflict do nothing returning id",
      [id, context.tenantId, sourceClass, edge.source.canonicalUri],
    )
  ).rows[0];
  const row =
    inserted ??
    (
      await context.client.query<Row>("select id from evidence.source where tenant_id=$1 and canonical_url=$2", [
        context.tenantId,
        edge.source.canonicalUri,
      ])
    ).rows[0];
  if (!row) throw domainError("SOURCE_IDENTITY_CONFLICT", "Canonical source URI could not be resolved");
  if (inserted) affected.push({ schema: "evidence", table: "source", id: String(row.id) });
  return String(row.id);
}

async function capture(
  context: Context,
  input: { edge: Evidence; sourceId: string },
  affected: AffectedRef[],
): Promise<string> {
  const { edge, sourceId } = input;
  // Share preparation's source lock before resolving an acquisition's canonical capture.
  await context.client.query("select id from evidence.source where tenant_id=$1 and id=$2 for update", [
    context.tenantId,
    sourceId,
  ]);
  const originalMethod = edge.capture.captureMethod;
  const method = canonicalCaptureMethod(originalMethod);
  const metadata = (
    await context.client.query<Row>(
      "select sha256,media_type,size_bytes,producer_attempt_id from orchestration.artifact where tenant_id=$1 and id=$2",
      [context.tenantId, edge.capture.artifactId],
    )
  ).rows[0];
  if (
    !metadata ||
    metadata.sha256 !== edge.capture.digest.slice(7) ||
    metadata.media_type !== edge.capture.mediaType ||
    Number(metadata.size_bytes) !== edge.capture.byteLength
  )
    throw domainError("PROVENANCE_ARTIFACT_MISMATCH", "Captured artifact metadata differs from sealed evidence");
  const existing = (
    await context.client.query<Row>(
      `select id from evidence.source_capture where tenant_id=$1 and source_id=$2 and artifact_id=$3 and content_sha256=$4
    and captured_at=$5::timestamptz and capture_method=$6 and capture_method_version=$7 and coalesce(context->>'captureMethod',capture_method)=$8 order by id`,
      [
        context.tenantId,
        sourceId,
        edge.capture.artifactId,
        edge.capture.digest.slice(7),
        edge.capture.capturedAt,
        method,
        edge.capture.captureMethodVersion,
        originalMethod,
      ],
    )
  ).rows;
  if (existing.length > 1)
    throw domainError("CAPTURE_IDENTITY_AMBIGUOUS", "Multiple canonical captures match the sealed capture identity");
  if (existing[0]) return String(existing[0].id);
  const id = deterministicId("evidence.source_capture", canonicalJson([context.tenantId, edge.capture.captureId]));
  await insertImmutable(
    context,
    {
      table: "source_capture",
      id,
      columns: {
        tenant_id: context.tenantId,
        source_id: sourceId,
        artifact_id: edge.capture.artifactId,
        content_sha256: edge.capture.digest.slice(7),
        media_type: edge.capture.mediaType,
        captured_at: edge.capture.capturedAt,
        capture_method: method,
        capture_method_version: edge.capture.captureMethodVersion,
        request_url: edge.source.canonicalUri,
        produced_by_attempt_id: metadata.producer_attempt_id ?? null,
        context: {
          verificationCaptureId: edge.capture.captureId,
          verificationSourceId: edge.source.sourceId,
          logicalIdentity: edge.source.logicalIdentity,
          captureMethod: originalMethod,
        },
      },
    },
    affected,
  );
  return id;
}

async function locator(
  context: Context,
  input: { edge: Evidence; captureId: string },
  affected: AffectedRef[],
): Promise<string> {
  const { edge, captureId } = input;
  const id = deterministicId(
    "evidence.locator",
    canonicalJson([
      context.tenantId,
      captureId,
      edge.representationArtifactId,
      edge.selector,
      edge.selectedContentDigest,
    ]),
  );
  await insertImmutable(
    context,
    {
      table: "locator",
      id,
      columns: {
        tenant_id: context.tenantId,
        verification_contract_version: "verification.v1",
        capture_id: captureId,
        media_type: edge.capture.mediaType,
        selector: edge.selector,
        representation_artifact_id: edge.representationArtifactId,
        selector_sha256: edge.selectorDigest.slice(7),
        selected_size_bytes: edge.selectedSizeBytes,
        occurrence_count: edge.occurrenceCount,
        resolution_state: "resolved",
        normalization_policy: edge.normalization,
        resolution_version: edge.resolverVersion,
        selector_kind: edge.selector.kind,
        selected_content_sha256: edge.selectedContentDigest.slice(7),
        extractor_name: "verification.v1",
        extractor_version: "sealed-selector.v1",
        extraction_params: {
          representationArtifactId: edge.representationArtifactId,
          parserLineageArtifactIds: edge.parserLineageArtifactIds,
        },
        ...(edge.selector.kind === "media_timecode"
          ? { start_ms: edge.selector.startMs, end_ms: edge.selector.endMs }
          : {}),
      },
    },
    affected,
  );
  return id;
}

async function insertImmutable(
  context: Context,
  input: {
    table: "source_capture" | "locator" | "claim_evidence_link";
    id: string;
    columns: Row;
  },
  affected: AffectedRef[],
): Promise<void> {
  const columns = Object.keys(input.columns);
  const values = Object.values(input.columns).map((value) =>
    typeof value === "object" && value !== null && !Array.isArray(value) ? JSON.stringify(value) : value,
  );
  const row = (
    await context.client.query<Row>(
      `insert into evidence.${input.table}(id,${columns.join(",")}) values($1,${columns.map((_, i) => `$${i + 2}`).join(",")}) on conflict(id) do nothing returning id`,
      [input.id, ...values],
    )
  ).rows[0];
  if (row) {
    affected.push({ schema: "evidence", table: input.table, id: input.id });
    return;
  }
  const existing = (await context.client.query<Row>(`select * from evidence.${input.table} where id=$1`, [input.id]))
    .rows[0];
  const conflicts = columns.filter((column) => {
    const value = existing?.[column];
    const normalized =
      value instanceof Date ? value.toISOString() : typeof input.columns[column] === "number" ? Number(value) : value;
    const expected =
      value instanceof Date ? new Date(String(input.columns[column])).toISOString() : input.columns[column];
    return canonicalJson(normalized) !== canonicalJson(expected);
  });
  if (!existing || conflicts.length)
    throw domainError("PROVENANCE_IDENTITY_CONFLICT", `Immutable ${input.table} identity has different evidence`, {
      fields: conflicts,
    });
}
