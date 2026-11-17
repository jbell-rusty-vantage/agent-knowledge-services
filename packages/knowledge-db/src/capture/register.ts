import type { Database, Json } from "@aiengineer/database-contract";
import { z } from "zod";
import { canonicalJson, sha256Hex } from "../db-read/canonical.js";
import { deterministicId } from "../ingestion/plan.js";
import type { KnowledgeSqlClient, KnowledgeTransactions } from "../ports.js";
import { KnowledgeError, domainError, infrastructureError } from "../schema-workspace/index.js";
import {
  CAPTURE_REGISTRATION_MEDIA_TYPES,
  CAPTURE_UNIT_GRAMMAR,
  captureFormatCode,
  isCaptureRegistrationMediaType,
  normalizeCaptureMediaType,
  planCaptureUnits,
  type CaptureRegistrationMediaType,
  type CaptureUnit,
} from "./units.js";

/**
 * Registers a capture the executor holds as an evidence capture of the AI Engineer database, with quotable content
 * units, so a governed write (`api.record_claim`, `api.record_probe_run`) can anchor to it. The rows are the lineage
 * the database documents for a fetch (acquisition.fetch -> orchestration.artifact -> evidence.source_capture ->
 * content.document -> document_version -> document_representation -> document_node), written in one transaction as
 * `executor_service`, the role the contract names as their only writer, with the tenant of the session. No function
 * of the contract writes these tables, so the rows are inserted directly, as the contract's grants and immutability
 * triggers allow; nothing is updated except the source's capture counter and nothing is deleted. The operation intent,
 * its receipt and the receipt targets (the capture, its source, its fetch) are written in the same transaction under
 * the intent type `capture_registration`, which contract 0.10.0 declares; against an older database that lacks it the
 * result says so (`INTENT_TYPE_UNDECLARED`) and the fetch row and the capture context record who registered it.
 *
 * Idempotent on the captured bytes: the same bytes from the same URL return the first registration (`replayed`).
 * Bytes stay where the executor's custody put them: with remote custody the capture binds the registered artifact;
 * without it the artifact row is registered `pending` (the bytes are on the executor host only).
 */

const Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const ArtifactRefSchema = z.strictObject({
  artifactId: z.string().min(1).max(200),
  digest: Digest,
  mediaType: z.string().min(1).max(200),
  byteLength: z.int().nonnegative(),
});
const Code = z
  .string()
  .regex(/^[a-z][a-z0-9_]{1,79}$/)
  .optional();

export const CapturedSourceSchema = z.strictObject({
  executorCaptureId: z.string().min(1).max(255),
  requestedUrl: z.string().min(1).max(4000),
  finalUrl: z.string().min(1).max(4000),
  title: z.string().min(1).max(1000).optional(),
  capturedAt: z.iso.datetime({ offset: true }),
  captureMethod: z.string().min(1).max(100),
  captureMethodVersion: z.string().min(1).max(100),
  sourceKind: z.enum(["web_page", "pdf", "api", "repository", "other"]),
  /** What was captured (for HTML: the page; the representation is the executor's text rendering of it). */
  sourceMediaType: z.string().min(1).max(200),
  /** The bytes the capture row hashes. */
  capture: ArtifactRefSchema,
  /** The text the units are read from; the same artifact as `capture` when the capture is text. */
  representation: ArtifactRefSchema.extend({ text: z.string() }),
  custody: z.enum(["remote", "local"]),
});
export type CapturedSource = z.infer<typeof CapturedSourceSchema>;

export const RegisterCaptureOptionsSchema = z.strictObject({
  title: z.string().min(1).max(500).optional(),
  version: z.string().min(1).max(100).optional(),
  documentType: Code,
  sourceRole: Code,
  quotes: z.array(z.string().min(1).max(4000)).max(20).optional(),
  maxUnits: z.int().min(1).max(200).optional(),
  missionId: z.uuid().optional(),
});
export type RegisterCaptureOptions = z.infer<typeof RegisterCaptureOptionsSchema>;

export interface RegisteredUnit {
  /** Paste into an evidence anchor and add a quote that is verbatim in the unit's text. */
  readonly anchor: { readonly capture_id: string; readonly node_id: string };
  readonly unit_kind: string;
  readonly ordinal: number;
  readonly start_offset: number | null;
  readonly end_offset: number | null;
  /** For a JSON unit: the pointer of a json_pointer anchor. */
  readonly pointer?: string;
  readonly text: string;
  readonly text_chars: number;
}

export interface QuoteAnchor {
  readonly quote: string;
  readonly status: "found" | "not_in_one_unit";
  /** Ready for chain_write: `evidence` of record_claim or `output` of record_probe_run. */
  readonly anchor?: { readonly capture_id: string; readonly node_id: string; readonly quote: string };
  readonly unit_kind?: string;
  readonly units_containing?: number;
}

export interface CaptureRegistration {
  readonly capture_id: string;
  readonly executor_capture_id: string;
  readonly source_id: string;
  readonly document_id: string;
  readonly document_version_id: string;
  readonly representation_id: string;
  readonly fetch_id: string;
  readonly media_type: string;
  readonly content_sha256: string;
  readonly custody: { readonly artifact_id: string; readonly storage_state: string; readonly remote: boolean };
  readonly units_total: number;
  readonly units: readonly RegisteredUnit[];
  readonly units_truncated: boolean;
  readonly anchors: readonly QuoteAnchor[];
  /**
   * The operation intent and receipt the registration is filed under. Null, with the reason, only against a database
   * older than contract 0.10.0, which declares no `orchestration.intent_type` for a capture registration.
   */
  readonly receipt:
    | { readonly intent_id: string; readonly receipt_id: string }
    | { readonly intent_id: null; readonly receipt_id: null; readonly unavailable: string };
  readonly replayed: boolean;
  readonly role: "executor_service";
  readonly next: string;
}

export interface CaptureRegistrarConfig {
  readonly db: KnowledgeTransactions;
  readonly executorVersion: string;
  readonly statementTimeoutMs?: number;
}

interface Ledger {
  readonly intent_id: string;
  readonly receipt_id: string;
}

/** One registration as its rows record it. */
interface RegisteredRow {
  readonly capture_id: string;
  readonly executor_capture_id: string;
  readonly source_id: string;
  readonly document_id: string;
  readonly document_version_id: string;
  readonly representation_id: string;
  readonly fetch_id: string;
  readonly media_type: string;
  readonly content_sha256: string;
  readonly artifact_id: string;
  readonly custody: string;
  readonly storage_state: string;
}

type Tables<S extends keyof Database> = Database[S] extends { Tables: infer T } ? T : never;
type Insert<S extends keyof Database, T extends keyof Tables<S>> = Tables<S>[T] extends { Insert: infer I } ? I : never;

const WRITE_TIMEOUT_MS = 60_000;
const LOCAL_BUCKET = "verification-executor-local";
const DEFAULT_UNITS = 30;
const EXCERPT_CHARS = 240;
const NODE_BATCH = 400;
/** The `orchestration.intent_type` code a capture registration's receipt is filed under (declared by contract 0.10.0). */
export const CAPTURE_INTENT_TYPE = "capture_registration";
const RECEIPT_UNAVAILABLE =
  "INTENT_TYPE_UNDECLARED: the database contract declares no orchestration.intent_type capture_registration, so no operation receipt is written; the acquisition.fetch row and the capture context record who registered it.";
const NEXT =
  "Quote a unit verbatim: chain_write record_claim with evidence [{capture_id, node_id, quote}], or record_probe_run with output {capture_id, node_id, quote}. evidence_units {captureId} lists every unit.";

const hexOf = (digest: string): string => digest.slice("sha256:".length);
const canonicalUrl = (url: string): string => {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
};
const bind = (value: unknown): unknown =>
  value !== null && typeof value === "object" && !(value instanceof Date) ? JSON.stringify(value) : value;

async function insert<S extends keyof Database, T extends keyof Tables<S> & string>(
  client: KnowledgeSqlClient,
  schema: S,
  table: T,
  row: Insert<S, T>,
  conflict = "on conflict do nothing",
): Promise<boolean> {
  const entries = Object.entries(row as Record<string, unknown>).filter(([, value]) => value !== undefined);
  const result = await client.query(
    `insert into ${String(schema)}.${table}(${entries.map(([column]) => column).join(",")})
     values(${entries.map((_, index) => `$${index + 1}`).join(",")}) ${conflict}`,
    entries.map(([, value]) => bind(value)),
  );
  return (result.rowCount ?? 0) > 0;
}

/** The database's own quote normalisation (verification.chain_norm), inlined for a role that may not call it. */
const NORM = (expression: string) =>
  String.raw`btrim(regexp_replace(translate(${expression}, chr(8217) || chr(8220) || chr(8221), '''""'), '\s+', ' ', 'g'))`;

function sourceClass(source: CapturedSource): string {
  if (/^file:/i.test(source.requestedUrl)) return "upload";
  return { web_page: "web_page", pdf: "pdf", api: "api", repository: "repository", other: "other" }[source.sourceKind];
}
function fetchTool(method: string): string {
  if (method === "firecrawl") return "firecrawl";
  if (method.startsWith("https_get")) return "http";
  if (method.startsWith("file_") || method === "firecrawl_parse") return "upload";
  return "other";
}
function captureMethodCode(method: string): string {
  if (method === "firecrawl") return "firecrawl";
  if (method.startsWith("https_get")) return "http";
  return "other";
}
function hostOf(url: string): { host: string | null; registrable: string | null } {
  try {
    const host = new URL(url).hostname || null;
    return { host, registrable: host ? host.split(".").slice(-2).join(".") : null };
  } catch {
    return { host: null, registrable: null };
  }
}

export function captureFailure(error: unknown): KnowledgeError {
  if (error instanceof KnowledgeError) return error;
  const pg = (error ?? {}) as { code?: string; message?: string; detail?: string; constraint?: string };
  const context = {
    ...(pg.code ? { sqlstate: pg.code } : {}),
    ...(pg.detail ? { detail: pg.detail } : {}),
    ...(pg.constraint ? { constraint: pg.constraint } : {}),
  };
  if (pg.code === "42501")
    return infrastructureError(
      "CAPTURE_ROLE_NOT_GRANTED",
      `CAPTURE_ROLE_NOT_GRANTED: executor_service may not write this row (${pg.message ?? "permission denied"}). Next: the database contract's grants changed; report it.`,
      context,
    );
  return infrastructureError("CAPTURE_REGISTRATION_FAILED", pg.message ?? String(error), context);
}

export class CaptureRegistrar {
  readonly #config: CaptureRegistrarConfig;

  constructor(config: CaptureRegistrarConfig) {
    this.#config = config;
  }

  async register(tenantId: string, rawSource: unknown, rawOptions: unknown = {}): Promise<CaptureRegistration> {
    const parsedSource = CapturedSourceSchema.safeParse(rawSource);
    if (!parsedSource.success)
      throw infrastructureError(
        "CAPTURE_SOURCE_INVALID",
        "the executor's capture record does not have the expected shape",
        {
          issues: parsedSource.error.issues,
        },
      );
    const parsedOptions = RegisterCaptureOptionsSchema.safeParse(rawOptions ?? {});
    if (!parsedOptions.success)
      throw domainError("INPUT_INVALID", "source_prepare_captured input does not match its schema", {
        issues: parsedOptions.error.issues,
      });
    const source = parsedSource.data;
    const options = parsedOptions.data;
    const mediaType = normalizeCaptureMediaType(source.sourceMediaType);
    if (!isCaptureRegistrationMediaType(mediaType))
      throw domainError(
        "CAPTURE_MEDIA_TYPE_UNSUPPORTED",
        `CAPTURE_MEDIA_TYPE_UNSUPPORTED: a ${mediaType} capture cannot be registered yet; supported: ${CAPTURE_REGISTRATION_MEDIA_TYPES.join(", ")}. Next: capture the page as text, Markdown, HTML or JSON.`,
        { mediaType, supported: CAPTURE_REGISTRATION_MEDIA_TYPES },
      );
    const representationBytes = new TextEncoder().encode(source.representation.text);
    if (
      `sha256:${sha256Hex(representationBytes)}` !== source.representation.digest ||
      representationBytes.byteLength !== source.representation.byteLength
    )
      throw infrastructureError(
        "CAPTURE_REPRESENTATION_MISMATCH",
        "the captured text does not match its artifact's digest and length",
      );
    const url = canonicalUrl(source.requestedUrl);
    const captureHex = hexOf(source.capture.digest);
    const key = `ks-capture:${tenantId}:${captureHex}:${sha256Hex(url).slice(0, 16)}`;
    const ids = {
      fetch: deterministicId("acquisition.fetch", key),
      capture: deterministicId("evidence.source_capture", key),
    };
    try {
      return await this.#config.db.transaction(
        {
          tenantId,
          role: "executor_service",
          statementTimeoutMs: this.#config.statementTimeoutMs ?? WRITE_TIMEOUT_MS,
        },
        async (client) => {
          await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
          // Every row is written in this one transaction, so the capture row stands for the whole registration.
          const replayed = await this.#registered(client, tenantId, ids.capture);
          if (!replayed) await this.#write(client, tenantId, { source, options, mediaType, url, key, ids });
          const summary = await this.#registered(client, tenantId, ids.capture);
          if (!summary)
            throw infrastructureError("CAPTURE_REGISTRATION_FAILED", "the registered capture is not readable");
          return this.#result(
            client,
            tenantId,
            summary,
            await this.#ledger(client, tenantId, key),
            !!replayed,
            options,
          );
        },
      );
    } catch (error) {
      throw captureFailure(error);
    }
  }

  async #write(
    client: KnowledgeSqlClient,
    tenantId: string,
    input: {
      source: CapturedSource;
      options: RegisterCaptureOptions;
      mediaType: CaptureRegistrationMediaType;
      url: string;
      key: string;
      ids: { fetch: string; capture: string };
    },
  ): Promise<void> {
    const { source, options, mediaType, url, key, ids } = input;
    const captureHex = hexOf(source.capture.digest);
    await this.#requireCode(client, "content.document_type", options.documentType, "DOCUMENT_TYPE_UNKNOWN");
    await this.#requireCode(client, "content.source_role", options.sourceRole, "SOURCE_ROLE_UNKNOWN");

    const captureArtifact = await this.#artifact(client, tenantId, source.capture, source.custody);
    const sameBytes = source.representation.artifactId === source.capture.artifactId;
    const representationArtifact = sameBytes
      ? captureArtifact
      : await this.#artifact(client, tenantId, source.representation, source.custody);

    await insert(client, "acquisition", "fetch", {
      id: ids.fetch,
      tenant_id: tenantId,
      origin_kind: "native_harness",
      origin_label: "knowledge-services verification executor",
      tool: fetchTool(source.captureMethod),
      tool_version: source.captureMethodVersion,
      request_url: source.requestedUrl,
      final_url: source.finalUrl,
      requested_at: source.capturedAt,
      completed_at: source.capturedAt,
      outcome: "captured",
      content_sha256: captureHex,
      media_type: source.capture.mediaType,
      size_bytes: source.capture.byteLength,
      notes: { executor_capture_id: source.executorCaptureId, capture_method: source.captureMethod },
    });

    const sourceRow = await this.#source(client, tenantId, source, url, key);
    await insert(client, "evidence", "source_capture", {
      id: ids.capture,
      tenant_id: tenantId,
      source_id: sourceRow.id,
      artifact_id: captureArtifact.id,
      content_sha256: captureHex,
      media_type: source.capture.mediaType,
      captured_at: source.capturedAt,
      capture_method: captureMethodCode(source.captureMethod),
      capture_method_version: source.captureMethodVersion,
      request_url: source.requestedUrl,
      acquisition_fetch_id: ids.fetch,
      context: {
        executor_capture_id: source.executorCaptureId,
        capture_method: source.captureMethod,
        source_media_type: mediaType,
        final_url: source.finalUrl,
        ...(source.title ? { title: source.title } : {}),
        custody: source.custody,
        registered_by: this.#config.executorVersion,
      },
    });
    await client.query(
      `update evidence.source set capture_count = capture_count + 1, last_capture_id = $2, last_seen_at = now(),
              first_seen_at = coalesce(first_seen_at, now())
        where tenant_id = $1 and id = $3`,
      [tenantId, ids.capture, sourceRow.id],
    );

    const document = await this.#document(client, tenantId, sourceRow.id, source, options);
    const versionLabel = options.version ?? `${source.capturedAt.slice(0, 10)}-${captureHex.slice(0, 12)}`;
    const versionId = deterministicId("content.document_version", `${document.id}\0${key}`);
    const taken = (
      await client.query<{ id: string }>(
        "select id::text from content.document_version where tenant_id = $1 and document_id = $2 and version_label = $3",
        [tenantId, document.id, versionLabel],
      )
    ).rows[0];
    if (taken && taken.id !== versionId)
      throw domainError(
        "VERSION_LABEL_TAKEN",
        `VERSION_LABEL_TAKEN: document ${document.id} already has a version labelled ${JSON.stringify(versionLabel)}. Next: send another version label, or none.`,
        { documentId: document.id, version: versionLabel },
      );
    await insert(client, "content", "document_version", {
      id: versionId,
      tenant_id: tenantId,
      document_id: document.id,
      version_label: versionLabel,
      manifest_sha256: captureHex,
      correction_state: "current",
      format_code: captureFormatCode(mediaType),
    });
    await insert(client, "content", "document_version_source_capture", {
      tenant_id: tenantId,
      document_version_id: versionId,
      source_capture_id: ids.capture,
      capture_role: "primary",
      identity_confidence: 1,
      resolution_evidence: {
        rule: "registered from the executor capture",
        executor_capture_id: source.executorCaptureId,
      },
    });

    const representationId = deterministicId(
      "content.document_representation",
      `${versionId}\0${source.representation.digest}\0${CAPTURE_UNIT_GRAMMAR}`,
    );
    await insert(client, "content", "document_representation", {
      id: representationId,
      tenant_id: tenantId,
      document_version_id: versionId,
      artifact_id: representationArtifact.id,
      representation_kind:
        mediaType === "application/json" ? "json" : mediaType === "text/markdown" ? "markdown" : "plain_text",
      representation_class: sameBytes ? "source_native" : "faithful_normalization",
      media_type: source.representation.mediaType,
      content_sha256: hexOf(source.representation.digest),
      acceptance_state: "accepted",
      source_native_byte_identical: sameBytes,
      grammar_version: CAPTURE_UNIT_GRAMMAR,
    });
    const units = planCaptureUnits({ representationId, text: source.representation.text, sourceMediaType: mediaType });
    await this.#nodes(client, tenantId, representationId, units);

    if (!(await this.#intentTypeDeclared(client))) return;
    const originDigest = `sha256:${sha256Hex(canonicalJson({ tenantId, key }))}`;
    const intentId = deterministicId("orchestration.operation_intent", key);
    const receiptId = deterministicId("orchestration.operation_receipt", key);
    await insert(client, "orchestration", "operation_intent", {
      id: intentId,
      tenant_id: tenantId,
      intent_type: CAPTURE_INTENT_TYPE,
      payload: {
        operation: "source_prepare_captured",
        executor_capture_id: source.executorCaptureId,
        request_url: source.requestedUrl,
        content_sha256: captureHex,
        representation_sha256: hexOf(source.representation.digest),
        grammar_version: CAPTURE_UNIT_GRAMMAR,
        actor: { session_role: "executor_service", label: this.#config.executorVersion },
      },
      idempotency_key: key,
      approval_state: "approved",
      origin_kind: "standalone",
      origin_digest: originDigest,
      ...(options.missionId ? { mission_id: options.missionId } : {}),
    });
    await insert(client, "orchestration", "operation_receipt", {
      id: receiptId,
      intent_id: intentId,
      executor_version: this.#config.executorVersion,
      outcome: "applied",
      changes_summary: { capture_id: ids.capture, representation_id: representationId, units: units.length },
      affected_refs: [
        { schema: "acquisition", table: "fetch", id: ids.fetch },
        ...(captureArtifact.created ? [{ schema: "orchestration", table: "artifact", id: captureArtifact.id }] : []),
        ...(!sameBytes && representationArtifact.created
          ? [{ schema: "orchestration", table: "artifact", id: representationArtifact.id }]
          : []),
        ...(sourceRow.created ? [{ schema: "evidence", table: "source", id: sourceRow.id }] : []),
        { schema: "evidence", table: "source_capture", id: ids.capture },
        ...(document.created ? [{ schema: "content", table: "document", id: document.id }] : []),
        { schema: "content", table: "document_version", id: versionId },
        { schema: "content", table: "document_representation", id: representationId },
        { schema: "content", table: "document_node", count: units.length },
      ],
      origin_digest: originDigest,
    });
    const targets: [string, string, string, string, string][] = [
      ["evidence", "source_capture", ids.capture, "subject", "created"],
      ["evidence", "source", sourceRow.id, "provenance", sourceRow.created ? "created" : "reused"],
      ["acquisition", "fetch", ids.fetch, "provenance", "created"],
    ];
    for (const [ordinal, [schema, table, id, role, action]] of targets.entries())
      await insert(client, "orchestration", "operation_receipt_target", {
        tenant_id: tenantId,
        receipt_id: receiptId,
        ordinal,
        target_schema: schema,
        target_table: table,
        target_id: id,
        role,
        action,
      });
  }

  /** The contract declares the intent type of a capture registration (`orchestration.intent_type`). */
  async #intentTypeDeclared(client: KnowledgeSqlClient): Promise<boolean> {
    return (
      (await client.query("select 1 from orchestration.intent_type where code = $1", [CAPTURE_INTENT_TYPE])).rows
        .length > 0
    );
  }

  /** The registration a capture row stands for, read back from the rows themselves. */
  async #registered(
    client: KnowledgeSqlClient,
    tenantId: string,
    captureId: string,
  ): Promise<RegisteredRow | undefined> {
    const row = (
      await client.query<RegisteredRow>(
        `select c.id::text as capture_id, c.context ->> 'executor_capture_id' as executor_capture_id,
                c.source_id::text as source_id, v.document_id::text as document_id, v.id::text as document_version_id,
                r.id::text as representation_id, c.acquisition_fetch_id::text as fetch_id,
                c.context ->> 'source_media_type' as media_type, c.content_sha256, c.artifact_id::text as artifact_id,
                c.context ->> 'custody' as custody, a.storage_state
           from evidence.source_capture c
           join content.document_version_source_capture vc on vc.tenant_id = c.tenant_id and vc.source_capture_id = c.id
           join content.document_version v on v.tenant_id = vc.tenant_id and v.id = vc.document_version_id
           join content.document_representation r
             on r.tenant_id = v.tenant_id and r.document_version_id = v.id and r.grammar_version = $3
           join orchestration.artifact a on a.tenant_id = c.tenant_id and a.id = c.artifact_id
          where c.tenant_id = $1 and c.id = $2
          order by r.created_at, r.id limit 1`,
        [tenantId, captureId, CAPTURE_UNIT_GRAMMAR],
      )
    ).rows[0];
    return row;
  }

  async #ledger(client: KnowledgeSqlClient, tenantId: string, key: string): Promise<Ledger | undefined> {
    return (
      await client.query<Ledger>(
        `select i.id::text as intent_id, r.id::text as receipt_id
           from orchestration.operation_intent i join orchestration.operation_receipt r on r.intent_id = i.id
          where i.tenant_id = $1 and i.idempotency_key = $2`,
        [tenantId, key],
      )
    ).rows[0];
  }

  async #requireCode(
    client: KnowledgeSqlClient,
    table: "content.document_type" | "content.source_role",
    code: string | undefined,
    error: string,
  ): Promise<void> {
    if (code === undefined) return;
    const found = (await client.query(`select 1 from ${table} where code = $1`, [code])).rows.length > 0;
    if (!found)
      throw domainError(
        error,
        `${error}: ${JSON.stringify(code)} is not a code of ${table}. Next: read the vocabulary with schema_get or leave it out.`,
        {
          code,
        },
      );
  }

  /**
   * The artifact row a capture or representation binds. With remote custody the executor registered it when it
   * captured; it is checked, never rewritten. Without remote custody it is registered here, `pending`, at the
   * executor's content address, as the ledger registers local-only artifacts.
   */
  async #artifact(
    client: KnowledgeSqlClient,
    tenantId: string,
    ref: CapturedSource["capture"],
    custody: CapturedSource["custody"],
  ): Promise<{ id: string; storageState: string; created: boolean }> {
    const hex = hexOf(ref.digest);
    const id =
      custody === "remote" ? ref.artifactId : deterministicId("orchestration.artifact:local", `${tenantId}\0${hex}`);
    let created = false;
    if (custody === "local")
      created = await insert(
        client,
        "orchestration",
        "artifact",
        {
          id,
          tenant_id: tenantId,
          artifact_type: "source_capture",
          sha256: hex,
          bucket_class: "source_captures",
          storage_bucket: LOCAL_BUCKET,
          object_path: `${tenantId}/${hex.slice(0, 2)}/${hex}`,
          media_type: ref.mediaType,
          size_bytes: ref.byteLength,
          storage_state: "pending",
          available_at: null,
        },
        "on conflict do nothing",
      );
    const columns = "id::text, artifact_type, sha256, media_type, size_bytes, storage_state";
    const row = (
      await client.query<{
        id: string;
        artifact_type: string;
        sha256: string;
        media_type: string | null;
        size_bytes: string | number | null;
        storage_state: string;
      }>(
        custody === "remote"
          ? `select ${columns} from orchestration.artifact where tenant_id = $1 and id = $2`
          : `select ${columns} from orchestration.artifact
              where tenant_id = $1 and storage_bucket = $2 and object_path = $3 and verification_contract_version is null`,
        custody === "remote" ? [tenantId, id] : [tenantId, LOCAL_BUCKET, `${tenantId}/${hex.slice(0, 2)}/${hex}`],
      )
    ).rows[0];
    if (!row)
      throw infrastructureError(
        "CAPTURE_CUSTODY_MISSING",
        `CAPTURE_CUSTODY_MISSING: artifact ${ref.artifactId} is not registered in remote custody. Next: retry once the executor's custody is reachable.`,
        { artifactId: ref.artifactId },
      );
    if (
      row.sha256 !== hex ||
      row.artifact_type !== "source_capture" ||
      row.media_type !== ref.mediaType ||
      Number(row.size_bytes) !== ref.byteLength
    )
      throw infrastructureError(
        "CAPTURE_ARTIFACT_CONFLICT",
        "the registered artifact for these bytes has another type, media type or size",
        { artifactId: row.id, artifactType: row.artifact_type, mediaType: row.media_type },
      );
    return { id: row.id, storageState: row.storage_state, created };
  }

  async #source(
    client: KnowledgeSqlClient,
    tenantId: string,
    source: CapturedSource,
    url: string,
    key: string,
  ): Promise<{ id: string; created: boolean }> {
    const found = (
      await client.query<{ id: string }>(
        `select id::text from evidence.source
          where tenant_id = $1 and canonical_url = $2 and verification_contract_version is null
          order by created_at, id limit 1 for update`,
        [tenantId, url],
      )
    ).rows[0];
    if (found) return { id: found.id, created: false };
    const id = deterministicId("evidence.source", `${tenantId}\0${url}\0${key}`);
    const { host, registrable } = hostOf(url);
    await insert(client, "evidence", "source", {
      id,
      tenant_id: tenantId,
      source_class: sourceClass(source),
      canonical_url: url,
      host,
      registrable_domain: registrable,
      source_kind: source.sourceKind,
      first_seen_at: source.capturedAt,
      last_seen_at: source.capturedAt,
      capture_count: 0,
    });
    return { id, created: true };
  }

  async #document(
    client: KnowledgeSqlClient,
    tenantId: string,
    sourceId: string,
    source: CapturedSource,
    options: RegisterCaptureOptions,
  ): Promise<{ id: string; created: boolean }> {
    const found = (
      await client.query<{ id: string }>(
        `select id::text from content.document
          where tenant_id = $1 and canonical_source_id = $2 and lifecycle = 'active'
          order by created_at, id limit 1`,
        [tenantId, sourceId],
      )
    ).rows[0];
    if (found) return { id: found.id, created: false };
    const id = deterministicId("content.document", `${tenantId}\0${sourceId}`);
    await insert(client, "content", "document", {
      id,
      tenant_id: tenantId,
      document_type_code: options.documentType ?? "unclassified",
      canonical_title: options.title ?? source.title ?? source.finalUrl,
      canonical_source_id: sourceId,
      lifecycle: "active",
      source_role_code: options.sourceRole ?? "unknown",
      source_role_method: options.sourceRole ? "model" : "default",
      attributes: { registered_by: this.#config.executorVersion, executor_capture_id: source.executorCaptureId },
    });
    return { id, created: true };
  }

  async #nodes(
    client: KnowledgeSqlClient,
    tenantId: string,
    representationId: string,
    units: readonly CaptureUnit[],
  ): Promise<void> {
    for (let start = 0; start < units.length; start += NODE_BATCH) {
      const batch = units.slice(start, start + NODE_BATCH);
      const columns = [
        "id",
        "tenant_id",
        "representation_id",
        "ordinal",
        "stable_local_key",
        "unit_kind",
        "unit_kind_version",
        "inline_text",
        "selector",
        "start_offset",
        "end_offset",
        "start_ms",
        "end_ms",
        "normalized_content_sha256",
        "attributes",
        "logical_key",
        "grammar_version",
      ] as const;
      const values: unknown[] = [];
      const rows = batch.map((unit) => {
        // Typed against the contract's generated insert type, so a renamed or removed column fails to compile.
        const row: Required<Pick<Insert<"content", "document_node">, (typeof columns)[number]>> = {
          id: unit.id,
          tenant_id: tenantId,
          representation_id: representationId,
          ordinal: unit.ordinal,
          stable_local_key: unit.stableLocalKey,
          unit_kind: unit.unitKind,
          unit_kind_version: 1,
          inline_text: unit.text,
          selector: unit.selector as Json,
          start_offset: unit.startOffset,
          end_offset: unit.endOffset,
          start_ms: unit.startMs,
          end_ms: unit.endMs,
          normalized_content_sha256: unit.contentSha256,
          attributes: unit.attributes as Json,
          logical_key: unit.logicalKey,
          grammar_version: CAPTURE_UNIT_GRAMMAR,
        };
        return `(${columns
          .map((column) => {
            values.push(bind(row[column]));
            return `$${values.length}`;
          })
          .join(",")})`;
      });
      await client.query(
        `insert into content.document_node(${columns.join(",")}) values ${rows.join(",")} on conflict (id) do nothing`,
        values,
      );
    }
  }

  async #result(
    client: KnowledgeSqlClient,
    tenantId: string,
    summary: RegisteredRow,
    ledger: Ledger | undefined,
    replayed: boolean,
    options: RegisterCaptureOptions,
  ): Promise<CaptureRegistration> {
    const captureId = summary.capture_id;
    const representationId = summary.representation_id;
    const limit = options.maxUnits ?? DEFAULT_UNITS;
    const rows = (
      await client.query<{
        node_id: string;
        unit_kind: string;
        ordinal: number;
        start_offset: number | null;
        end_offset: number | null;
        pointer: string | null;
        text: string;
        text_chars: number;
        total: string;
      }>(
        `select n.id::text as node_id, n.unit_kind, n.ordinal, n.start_offset, n.end_offset,
                case when n.selector ->> 'kind' = 'json_pointer' then n.selector ->> 'pointer' end as pointer,
                left(n.inline_text, $3::int) as text, length(n.inline_text) as text_chars, count(*) over () as total
           from content.document_node n
          where n.tenant_id = $1 and n.representation_id = $2
          order by n.ordinal limit $4::int`,
        [tenantId, representationId, EXCERPT_CHARS, limit],
      )
    ).rows;
    const total = Number(rows[0]?.total ?? 0);
    const anchors: QuoteAnchor[] = [];
    for (const quote of options.quotes ?? []) {
      // A quote that normalises to nothing is in no unit: the database refuses it (QUOTE_REQUIRED) and every
      // position('' in <text>) would otherwise match the first unit.
      const found = (
        await client.query<{ node_id: string; unit_kind: string; containing: string }>(
          `select n.id::text as node_id, n.unit_kind, count(*) over () as containing
             from content.document_node n
            where n.tenant_id = $1 and n.representation_id = $2 and ${NORM("$3::text")} <> ''
              and position(${NORM("$3::text")} in ${NORM("n.inline_text")}) > 0
            order by length(n.inline_text), n.ordinal limit 1`,
          [tenantId, representationId, quote],
        )
      ).rows[0];
      anchors.push(
        found
          ? {
              quote,
              status: "found",
              anchor: { capture_id: captureId, node_id: found.node_id, quote },
              unit_kind: found.unit_kind,
              units_containing: Number(found.containing),
            }
          : { quote, status: "not_in_one_unit" },
      );
    }
    return {
      capture_id: captureId,
      executor_capture_id: summary.executor_capture_id,
      source_id: summary.source_id,
      document_id: summary.document_id,
      document_version_id: summary.document_version_id,
      representation_id: representationId,
      fetch_id: summary.fetch_id,
      media_type: summary.media_type,
      content_sha256: summary.content_sha256,
      custody: {
        artifact_id: summary.artifact_id,
        storage_state: summary.storage_state,
        remote: summary.custody === "remote",
      },
      units_total: total,
      units: rows.map((row) => ({
        anchor: { capture_id: captureId, node_id: row.node_id },
        unit_kind: row.unit_kind,
        ordinal: Number(row.ordinal),
        start_offset: row.start_offset === null ? null : Number(row.start_offset),
        end_offset: row.end_offset === null ? null : Number(row.end_offset),
        ...(row.pointer ? { pointer: row.pointer } : {}),
        text: row.text,
        text_chars: Number(row.text_chars),
      })),
      units_truncated: total > rows.length,
      anchors,
      receipt: ledger
        ? { intent_id: ledger.intent_id, receipt_id: ledger.receipt_id }
        : { intent_id: null, receipt_id: null, unavailable: RECEIPT_UNAVAILABLE },
      replayed,
      role: "executor_service",
      next: NEXT,
    };
  }
}
