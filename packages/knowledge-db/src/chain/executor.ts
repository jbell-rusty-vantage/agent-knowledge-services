import {
  EVIDENCE_UNITS_FILTERS,
  EvidenceUnitsInputSchema,
  GOVERNED_WRITE_SQLSTATE_CLASS,
  governedWriteError,
  parseChainWrite,
  type ChainOperationName,
  type ChainRefusal,
  type ChainRole,
} from "@aiengineer/knowledge-contracts";
import type { KnowledgeTransactions } from "../ports.js";
import { KnowledgeError, domainError, infrastructureError } from "../schema-workspace/index.js";
import { chainStatement } from "./functions.js";

/**
 * The research verification chain on the AI Engineer database: each write is one governed `api` function, called
 * as the bounded role the operation contract names, in a transaction that carries only the tenant. Nothing is
 * inserted into a table here, no status is set and no row is changed: what the functions refuse, this refuses,
 * with the database's stable code and what to do next.
 */
export interface GovernedChainConfig {
  readonly db: KnowledgeTransactions;
  readonly statementTimeoutMs?: number;
}

export interface ChainWriteResult {
  readonly operation: string;
  readonly function: string;
  /** The database role the write ran as (the ledger records it as `session_role`). */
  readonly role: ChainRole;
  /** The function's own result: the ids written, `intent_id`, `receipt_id` and `replayed`. */
  readonly result: Record<string, unknown>;
}

export interface EvidenceUnit {
  /** Paste into an evidence anchor and add the quote. */
  readonly anchor: { readonly capture_id: string; readonly node_id: string };
  readonly document_id: string;
  readonly document_version_id: string;
  readonly source_id: string;
  readonly unit_kind: string;
  readonly ordinal: number;
  readonly request_url: string | null;
  readonly captured_at: string;
  readonly capture_role: string;
  /** The start of the unit's text; a quote must be verbatim in the whole text. */
  readonly text: string;
  readonly text_chars: number;
  readonly text_truncated: boolean;
}

export interface EvidenceUnitsResult {
  readonly units: readonly EvidenceUnit[];
  readonly truncated: boolean;
  readonly role: "executor_service";
}

const WRITE_TIMEOUT_MS = 30_000;
const READ_TIMEOUT_MS = 15_000;
const DEFAULT_UNITS = 20;
const DEFAULT_TEXT_CHARS = 600;
const STABLE_CODE = /^[A-Z][A-Z0-9_]{2,80}$/;

/** A refusal raised before anything was submitted. */
export function chainRefusalError(refusal: ChainRefusal): KnowledgeError {
  return domainError(refusal.code, `${refusal.code}: ${refusal.message} Next: ${refusal.next}`, {
    class: refusal.class,
    next: refusal.next,
    submitted: false,
    ...(refusal.details === undefined ? {} : { refused: refusal.details }),
  });
}

/**
 * A governed function raises its stable code as the message, the class as the SQLSTATE and the specifics as the
 * detail. The code is kept as the tool error's code, with what it means and what to do next.
 */
export function chainFailure(
  error: unknown,
  call: { readonly operation: string; readonly function: string; readonly role: string },
): KnowledgeError {
  if (error instanceof KnowledgeError) return error;
  const pg = (error ?? {}) as { code?: string; message?: string; detail?: string; hint?: string };
  const message = (pg.message ?? String(error)).trim();
  const context = {
    ...call,
    submitted: true,
    ...(pg.code ? { sqlstate: pg.code } : {}),
    ...(pg.detail ? { detail: pg.detail } : {}),
    ...(pg.hint ? { hint: pg.hint } : {}),
  };
  const known = governedWriteError(message);
  if (known)
    return domainError(message, `${message}: ${known.meaning} Next: ${known.next}`, {
      class: known.class,
      next: known.next,
      ...context,
    });
  if (pg.code === "42501" && /permission denied/i.test(message)) {
    const entry = governedWriteError("CHAIN_ROLE_NOT_GRANTED")!;
    return infrastructureError(
      "CHAIN_ROLE_NOT_GRANTED",
      `CHAIN_ROLE_NOT_GRANTED: ${entry.meaning} Next: ${entry.next}`,
      {
        class: entry.class,
        next: entry.next,
        ...context,
        databaseMessage: message,
      },
    );
  }
  const errorClass = pg.code ? GOVERNED_WRITE_SQLSTATE_CLASS[pg.code] : undefined;
  if (STABLE_CODE.test(message) && errorClass)
    return domainError(message, `${message}: the database refused this write (${errorClass}).`, {
      class: errorClass,
      next: "Read the detail; this code is newer than this executor's table of governed-write errors.",
      ...context,
    });
  return infrastructureError("CHAIN_WRITE_FAILED", message, context);
}

const escapeLike = (text: string): string => text.replace(/[\\%_]/g, (character) => `\\${character}`);

export class GovernedChainExecutor {
  readonly #config: GovernedChainConfig;

  constructor(config: GovernedChainConfig) {
    this.#config = config;
  }

  /**
   * One governed write. The whole request is validated first (the three rules, the envelope, the operation's input
   * schema); a request that fails is refused and nothing is submitted. The function runs in one transaction as the
   * operation's role, and a refused write rolls that transaction back.
   */
  async write(tenantId: string, request: unknown): Promise<ChainWriteResult> {
    const parsed = parseChainWrite(request);
    if (!parsed.ok) throw chainRefusalError(parsed.refusal);
    const { operation } = parsed;
    const statement = chainStatement({
      operation: operation.operation as ChainOperationName,
      function: operation.function,
      idempotencyKey: parsed.idempotencyKey,
      actor: parsed.actor,
      fields: parsed.input,
    });
    const call = { operation: operation.operation, function: operation.function, role: operation.role };
    try {
      const result = await this.#config.db.transaction(
        {
          tenantId,
          role: operation.role,
          statementTimeoutMs: this.#config.statementTimeoutMs ?? WRITE_TIMEOUT_MS,
        },
        async (client) =>
          (await client.query<{ result: Record<string, unknown> }>(statement.text, statement.values)).rows[0]?.result,
      );
      if (result === undefined || result === null)
        throw infrastructureError("CHAIN_WRITE_FAILED", `${operation.function} returned no result`, call);
      return { ...call, result };
    } catch (error) {
      throw chainFailure(error, call);
    }
  }

  /**
   * The content units a claim can quote, each with the capture it was read from: what an evidence anchor needs
   * (`capture_id`, `node_id`) and the text to quote from. The unit-to-capture link
   * (`content.document_version_source_capture`) is readable by `executor_service` only, so this read runs as that
   * role, read-only. At least one filter is required.
   */
  async evidenceUnits(tenantId: string, rawInput: unknown): Promise<EvidenceUnitsResult> {
    const parsed = EvidenceUnitsInputSchema.safeParse(rawInput ?? {});
    if (!parsed.success)
      throw domainError("INPUT_INVALID", "evidence_units input does not match its schema", {
        issues: parsed.error.issues,
      });
    const input = parsed.data;
    if (!EVIDENCE_UNITS_FILTERS.some((name) => input[name] !== undefined))
      throw domainError(
        "EVIDENCE_UNITS_FILTER_REQUIRED",
        `EVIDENCE_UNITS_FILTER_REQUIRED: name at least one of ${EVIDENCE_UNITS_FILTERS.join(", ")}.`,
        { filters: EVIDENCE_UNITS_FILTERS },
      );
    const limit = input.limit ?? DEFAULT_UNITS;
    const textChars = input.maxTextChars ?? DEFAULT_TEXT_CHARS;
    const rows = await this.#config.db.transaction(
      { tenantId, role: "executor_service", readOnly: true, statementTimeoutMs: READ_TIMEOUT_MS },
      async (client) =>
        (
          await client.query(
            `select n.id::text as node_id, vc.source_capture_id::text as capture_id, v.document_id::text as document_id,
                    v.id::text as document_version_id, c.source_id::text as source_id, n.unit_kind, n.ordinal,
                    c.request_url, c.captured_at, vc.capture_role,
                    left(n.inline_text, $7::int) as text, length(n.inline_text) as text_chars
               from content.document_node n
               join content.document_representation r on r.tenant_id = n.tenant_id and r.id = n.representation_id
               join content.document_version v on v.tenant_id = r.tenant_id and v.id = r.document_version_id
               join content.document_version_source_capture vc on vc.tenant_id = v.tenant_id and vc.document_version_id = v.id
               join evidence.source_capture c on c.tenant_id = vc.tenant_id and c.id = vc.source_capture_id
              where n.tenant_id = $1::uuid
                and btrim(coalesce(n.inline_text, '')) <> ''
                and ($2::uuid is null or vc.source_capture_id = $2::uuid)
                and ($3::uuid is null or v.document_id = $3::uuid)
                and ($4::uuid is null or n.id = $4::uuid)
                and ($5::text is null or c.request_url = $5::text)
                and ($6::text is null or n.inline_text ilike '%' || $6::text || '%')
              order by c.captured_at desc, vc.source_capture_id, r.id, n.ordinal, n.id
              limit $8::int`,
            [
              tenantId,
              input.captureId ?? null,
              input.documentId ?? null,
              input.nodeId ?? null,
              input.url ?? null,
              input.text === undefined ? null : escapeLike(input.text),
              textChars,
              limit + 1,
            ],
          )
        ).rows,
    );
    return {
      units: rows.slice(0, limit).map((row) => ({
        anchor: { capture_id: String(row.capture_id), node_id: String(row.node_id) },
        document_id: String(row.document_id),
        document_version_id: String(row.document_version_id),
        source_id: String(row.source_id),
        unit_kind: String(row.unit_kind),
        ordinal: Number(row.ordinal),
        request_url: row.request_url === null ? null : String(row.request_url),
        captured_at: row.captured_at instanceof Date ? row.captured_at.toISOString() : String(row.captured_at),
        capture_role: String(row.capture_role),
        text: String(row.text),
        text_chars: Number(row.text_chars),
        text_truncated: Number(row.text_chars) > String(row.text).length,
      })),
      truncated: rows.length > limit,
      role: "executor_service",
    };
  }
}
