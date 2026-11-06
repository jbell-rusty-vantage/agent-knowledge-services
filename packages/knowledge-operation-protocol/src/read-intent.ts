import { z } from "zod";
import { type Digest, type JsonValue, digestCanonical } from "./canonical.js";
import {
  DigestSchema,
  IdSchema,
  InstantSchema,
  JsonDocumentSchema,
  type JsonDocument,
  RefSchema,
  SafeIntSchema,
} from "./primitives.js";

/**
 * `knowledge.read_intent` (BellLabs provenance sprint, OVE-204 slice 4): a bounded, recorded read of a binding's
 * knowledge store through the K01 gateway, answered synchronously (a result operation like `knowledge.plan_preview`).
 *
 * Envelope: `operation: "knowledge.read_intent"`, `effect: null`, no `use`/`audience`, `input.nativeContract =
 * {name: "knowledge-read-intent", version: "v1"}` with the request inline. The credential is a non-effect credential
 * whose `operations` claim grants `knowledge.read_intent` (an evaluator credential cannot: the operation is not one of
 * the evaluator operations). Every served read is recorded as one `knowledge_verification.operation` row (verified
 * origin digest, `run_id` null, `subject` null, `request = {operation, readIntent}`); `resultRef`/`retainedRef` name
 * the frozen result document in custody only when `persist` is true.
 *
 * Digests: every digest on the wire is K01 `digestCanonical` (`kop-canonical-json.v1`); one scheme. Row and value
 * bodies are first made protocol JSON by {@link toWireJson} (numbers that are not safe integers become their decimal
 * string), then `contentDigest = digestCanonical(body)` where the body is `rows` for a row set, `value` otherwise, and
 * `null` for a skipped or failed operation. `snapshotDigest` is {@link readIntentSnapshotDigest}.
 */
export const READ_INTENT_CONTRACT = { name: "knowledge-read-intent", version: "v1" } as const;
export const READ_INTENT_REQUEST_VERSION = "knowledge-read-intent-request.v1" as const;
export const READ_INTENT_RESULT_VERSION = "knowledge-read-intent-result.v1" as const;

/** The named queries a binding may serve through `knowledge.read_intent` (the production allowlist). */
export const READ_INTENT_NAMED_QUERIES = [
  "knowledge.head",
  "entity.resolve",
  "entity.by_identifier",
  "entity.card",
  "entity.relationships",
  "evidence.claims_for_entity",
  "relationships.current_by_kind",
  "vocab.relationship_kind",
] as const;
export const ReadIntentNamedQuerySchema = z.enum(READ_INTENT_NAMED_QUERIES);

/** Total canonical bytes of `rows`/`value` returned inline in one result; past it a body is withheld (digest kept). */
export const READ_INTENT_INLINE_MAX_BYTES = 262_144;
export const READ_INTENT_MAX_OPERATIONS = 32;

const OpIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);

export const ReadIntentNamedQueryOperationSchema = z.strictObject({
  opId: OpIdSchema,
  kind: z.literal("named_query"),
  query: ReadIntentNamedQuerySchema,
  params: z.record(z.string(), JsonDocumentSchema).default({}),
  limit: z.int().min(1).max(2000).optional(),
});
export const ReadIntentSchemaSearchOperationSchema = z.strictObject({
  opId: OpIdSchema,
  kind: z.literal("schema_search"),
  query: z.string().min(1).max(200),
  kinds: z.array(z.string().min(1).max(80)).max(16).optional(),
  limit: z.int().min(1).max(50).optional(),
});
export const ReadIntentSchemaGetOperationSchema = z.strictObject({
  opId: OpIdSchema,
  kind: z.literal("schema_get"),
  id: z.string().min(1).max(300),
  maxBytes: z.int().min(256).max(256_000).optional(),
});
export const ReadIntentOperationSchema = z.discriminatedUnion("kind", [
  ReadIntentNamedQueryOperationSchema,
  ReadIntentSchemaSearchOperationSchema,
  ReadIntentSchemaGetOperationSchema,
]);
export type ReadIntentOperation = z.infer<typeof ReadIntentOperationSchema>;

/** `knowledge-read-intent-request.v1`: the inline payload of `knowledge.read_intent`. */
export const KnowledgeReadIntentRequestSchema = z
  .strictObject({
    schemaVersion: z.literal(READ_INTENT_REQUEST_VERSION),
    /** The declared purpose; recorded with the operation, never a use decision. */
    purpose: z.string().min(1).max(200),
    /** Freeze the result document into custody (`retainedRef`) and retain the native snapshot. */
    persist: z.boolean().default(false),
    /** Read as of this knowledge sequence (named queries that take the knowledge clock); `null`: the current head. */
    atKnowledgeSeq: SafeIntSchema.nullable().default(null),
    operations: z.array(ReadIntentOperationSchema).min(1).max(READ_INTENT_MAX_OPERATIONS),
  })
  .superRefine((request, context) => {
    const seen = new Set<string>();
    for (const [index, operation] of request.operations.entries()) {
      if (seen.has(operation.opId)) {
        context.addIssue({ code: "custom", path: ["operations", index, "opId"], message: "duplicate opId" });
      }
      seen.add(operation.opId);
    }
  });
export type KnowledgeReadIntentRequest = z.infer<typeof KnowledgeReadIntentRequestSchema>;
export type KnowledgeReadIntentRequestInput = z.input<typeof KnowledgeReadIntentRequestSchema>;

export const ReadIntentOperationStatusSchema = z.enum(["ok", "empty", "skipped", "error", "truncated"]);

export const ReadIntentOperationResultSchema = z.strictObject({
  opId: OpIdSchema,
  kind: z.enum(["named_query", "schema_search", "schema_get"]),
  /** The named query, the search text, or the page id. */
  query: z.string().min(1).max(300).optional(),
  status: ReadIntentOperationStatusSchema,
  rowCount: SafeIntSchema,
  truncated: z.boolean(),
  /** `digestCanonical` of the full body (rows, value or null), also when the body is withheld. */
  contentDigest: DigestSchema,
  /** True when the body was not returned inline because the result's inline budget was spent. */
  bodyWithheld: z.boolean(),
  columns: z.array(z.string()).optional(),
  rows: z.array(z.record(z.string(), JsonDocumentSchema)).optional(),
  value: JsonDocumentSchema.optional(),
  error: z.strictObject({ code: z.string().min(1).max(120), message: z.string().max(2000) }).optional(),
});
export type ReadIntentOperationResult = z.infer<typeof ReadIntentOperationResultSchema>;

/** `knowledge-read-intent-result.v1`: the synchronous answer of `knowledge.read_intent`. */
export const KnowledgeReadIntentResultSchema = z.strictObject({
  schemaVersion: z.literal(READ_INTENT_RESULT_VERSION),
  /** The recorded `knowledge_verification.operation` id (`op-read_intent-…`); a replay answers the same id. */
  operationId: IdSchema,
  snapshotId: z.string().min(1).max(200),
  snapshotDigest: DigestSchema,
  knowledgeHead: z.strictObject({ knowledgeSeq: SafeIntSchema, updatedAt: InstantSchema }),
  atKnowledgeSeq: SafeIntSchema,
  contract: z.strictObject({
    migrationHead: z.string().min(1).max(200),
    workspaceFingerprint: z.string().min(1).max(200).optional(),
    catalogVersion: z.string().min(1).max(200).optional(),
  }),
  operations: z.array(ReadIntentOperationResultSchema).min(1).max(READ_INTENT_MAX_OPERATIONS),
  /** The frozen result document (with `retainedRef: null`) in custody when `persist`; otherwise null. */
  retainedRef: RefSchema.nullable(),
});
export type KnowledgeReadIntentResult = z.infer<typeof KnowledgeReadIntentResultSchema>;

/**
 * Protocol JSON of a native row or value: `undefined` members dropped, numbers that are not safe integers (floats,
 * huge integers) written as their decimal string, `-0` as `0`. Everything else unchanged.
 */
export function toWireJson(value: unknown): JsonDocument {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (Object.is(value, -0)) return 0;
      return Number.isSafeInteger(value) ? value : String(value);
    case "bigint":
      return value.toString();
    case "object":
      break;
    default:
      return String(value);
  }
  if (Array.isArray(value)) return value.map((item) => toWireJson(item));
  if (value instanceof Date) return value.toISOString();
  const out: Record<string, JsonDocument> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item !== undefined) out[key] = toWireJson(item);
  }
  return out;
}

/** `contentDigest` of one operation body (rows, value or null), over its protocol JSON. */
export function readIntentContentDigest(body: unknown): Digest {
  return digestCanonical(toWireJson(body) as JsonValue);
}

/**
 * `snapshotDigest`: `digestCanonical({atKnowledgeSeq, operations: [{opId, kind, query, status, rowCount, truncated,
 * contentDigest}]})`, operations in request order, `query` null when absent. Bodies enter only through their digests,
 * so withholding a body never changes it.
 */
export function readIntentSnapshotDigest(
  atKnowledgeSeq: number,
  operations: readonly Pick<
    ReadIntentOperationResult,
    "opId" | "kind" | "query" | "status" | "rowCount" | "truncated" | "contentDigest"
  >[],
): Digest {
  return digestCanonical({
    atKnowledgeSeq,
    operations: operations.map((operation) => ({
      opId: operation.opId,
      kind: operation.kind,
      query: operation.query ?? null,
      status: operation.status,
      rowCount: operation.rowCount,
      truncated: operation.truncated,
      contentDigest: operation.contentDigest,
    })),
  });
}
