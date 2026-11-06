import { z } from "zod";
import { DIGEST_PATTERN } from "./canonical.js";

/** Protocol version carried by every envelope, handle, status and receipt. */
export const PROTOCOL_VERSION = "ks.knowledge_operation.v2" as const;
export const ProtocolVersionSchema = z.literal(PROTOCOL_VERSION);

export const DigestSchema = z.string().regex(DIGEST_PATTERN);
export const IdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/);
export const ScopeIdSchema = z.string().min(1).max(200);
export const NameSchema = z.string().regex(/^[a-z][a-z0-9_.-]{0,119}$/);
export const SchemaVersionSchema = z.string().regex(/^[a-z][a-z0-9_.-]*\.v[0-9]+$/);
export const SafeIntSchema = z.int().min(0).max(Number.MAX_SAFE_INTEGER);
export const PositiveIntSchema = z.int().min(1).max(Number.MAX_SAFE_INTEGER);
/** RFC 3339 UTC instant with no trailing zeros in the fraction: the only form that canonicalizes to one byte string. */
export const InstantSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d*[1-9])?Z$/);
/** Money is a decimal string, never a float: `"0.0125"`. */
export const UsdSchema = z.string().regex(/^(0|[1-9]\d*)(\.\d{1,6})?$/);

/** The kinds a qualified handle can name. Domain stores may add kinds through their binding descriptor. */
export const REF_KINDS = [
  "task",
  "artifact",
  "assertion",
  "occurrence",
  "fragment",
  "support_set",
  "observation",
  "report",
  "report_kind",
  "rubric",
  "policy",
  "method",
  "mapping",
  "verification_run",
  "run_manifest",
  "use_decision",
  "adjudication",
  "receipt",
  "effect",
  "operation",
] as const;
export const RefKindSchema = z.enum(REF_KINDS);
export type RefKind = z.infer<typeof RefKindSchema>;

/**
 * `Ref<T>`: a qualified handle. Always carries tenant and binding, an immutable identity, the schema version of the
 * record it names and the digest of that record's canonical bytes. A bare id is never a handle (OC-D89).
 */
export const RefSchema = z.strictObject({
  kind: RefKindSchema,
  id: IdSchema,
  version: SchemaVersionSchema,
  digest: DigestSchema,
  tenant: ScopeIdSchema,
  binding: NameSchema,
});
export type Ref<K extends RefKind = RefKind> = Omit<z.infer<typeof RefSchema>, "kind"> & { readonly kind: K };

export function refOf<K extends RefKind>(kind: K) {
  return RefSchema.extend({ kind: z.literal(kind) });
}

export function refOfAny<K extends readonly [RefKind, ...RefKind[]]>(kinds: K) {
  return RefSchema.extend({ kind: z.enum(kinds) });
}

/** Two handles are the same handle only when every field agrees; digests make the comparison exact. */
export function sameRef(a: Ref, b: Ref): boolean {
  return (
    a.kind === b.kind &&
    a.id === b.id &&
    a.version === b.version &&
    a.digest === b.digest &&
    a.tenant === b.tenant &&
    a.binding === b.binding
  );
}

export const JsonPrimitiveSchema = z.union([z.string(), z.int(), z.boolean(), z.null()]);
export type JsonDocument = z.infer<typeof JsonPrimitiveSchema> | JsonDocument[] | { [key: string]: JsonDocument };
/** Protocol-carried JSON: integers only (see canonical.ts). */
export const JsonDocumentSchema: z.ZodType<JsonDocument> = z.lazy(() =>
  z.union([JsonPrimitiveSchema, z.array(JsonDocumentSchema), z.record(z.string(), JsonDocumentSchema)]),
);
