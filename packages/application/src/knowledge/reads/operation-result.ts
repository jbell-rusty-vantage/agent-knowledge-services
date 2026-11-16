import type {
  DurableReceiptResource,
  JsonValue,
  OperationResultResource,
  OperationResultStep,
  OperationStatus,
} from "@aiengineer/knowledge-contracts";

/**
 * What an operation produced, as an agent may read it. A finished step records its output in the body of its
 * receipt. This reduces each body to what the next call needs (identifiers, digests, timestamps, numbers, flags and
 * short state names) and gathers the identifiers by field name. Text, addresses, storage locations, provider
 * content and the worker's own bookkeeping never leave the service through this read.
 */

const MAXIMUM_DEPTH = 6;
const MAXIMUM_ITEMS = 50;
const MAXIMUM_IDS_PER_NAME = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const DIGEST = /^(?:sha256:)?[a-f0-9]{64}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
/** A short name without spaces: a state, a version, a media type or an error class. Never an address. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,95}$/u;
/** Fields whose string value is a name of that kind. */
const NAME_FIELD =
  /^(?:schemaVersion|useCase|kind|stage|state|status|outcome|decision|category|strategy|errorClass|mediaType|[A-Za-z]+(?:State|Status|Kind|Class|Grade|Outcome|Mode|Version|Strategy|Decision))$/u;
/** The worker's bookkeeping: not a result. */
const INTERNAL_FIELD = /^(?:eventId|fencingToken)$/u;
/** Words of a field name that mark where bytes live or who may reach them: such a field is never returned. */
const WITHHELD_WORDS = new Set([
  "bucket",
  "storage",
  "object",
  "path",
  "uri",
  "url",
  "secret",
  "token",
  "credential",
  "credentials",
  "password",
  "authorization",
  "signature",
  "lease",
  "holder",
  "executor",
  "idempotency",
]);
/** `objectKey` is withheld for its word `object`; `estimatedTokens` and `releaseId` are not withheld. */
const isWithheld = (field: string) =>
  field
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .some((word) => WITHHELD_WORDS.has(word));

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isIdentifier = (value: string) => UUID.test(value) || DIGEST.test(value);

interface Projection {
  omitted: number;
  readonly ids: Map<string, string[]>;
}

/** `artifact.id` is gathered as `artifactId` and `artifact.digest` as `artifactDigest`. */
function idName(key: string, parent: string | undefined): string {
  if ((key === "id" || key === "digest") && parent) return `${parent}${key === "id" ? "Id" : "Digest"}`;
  return key;
}

function remember(state: Projection, name: string, value: string): void {
  const values = state.ids.get(name) ?? [];
  if (!values.includes(value) && values.length < MAXIMUM_IDS_PER_NAME) values.push(value);
  state.ids.set(name, values);
}

/** The part of one value that may be returned, or `undefined` when nothing of it may. */
function project(
  value: unknown,
  key: string,
  parent: string | undefined,
  depth: number,
  state: Projection,
): JsonValue | undefined {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    if (isIdentifier(value)) {
      remember(state, idName(key, parent), value);
      return value;
    }
    if (TIMESTAMP.test(value)) return value;
    return NAME_FIELD.test(key) && NAME.test(value) && !value.includes("://") ? value : undefined;
  }
  if (depth >= MAXIMUM_DEPTH) return undefined;
  if (Array.isArray(value)) {
    const items: JsonValue[] = [];
    for (const item of value.slice(0, MAXIMUM_ITEMS)) {
      const kept = project(item, key, parent, depth + 1, state);
      if (kept === undefined) state.omitted += 1;
      else items.push(kept);
    }
    state.omitted += Math.max(0, value.length - MAXIMUM_ITEMS);
    return items.length > 0 || value.length === 0 ? items : undefined;
  }
  if (!isObject(value)) return undefined;
  const fields: Record<string, JsonValue> = {};
  for (const [name, child] of Object.entries(value)) {
    if (INTERNAL_FIELD.test(name)) continue;
    const kept = isWithheld(name) ? undefined : project(child, name, key || parent, depth + 1, state);
    if (kept === undefined) state.omitted += 1;
    else fields[name] = kept;
  }
  return Object.keys(fields).length > 0 ? fields : undefined;
}

/** One receipt as a step of the result: what it recorded, reduced as described above. */
export function operationResultStep(
  receipt: DurableReceiptResource,
  ids: Map<string, string[]> = new Map(),
): OperationResultStep {
  const state: Projection = { omitted: 0, ids };
  const output = project(receipt.body, "", undefined, 0, state) ?? {};
  return {
    receiptId: receipt.id,
    receiptKind: receipt.receiptKind,
    outcome: receipt.outcome,
    recordedAt: receipt.createdAt,
    ...(receipt.outputDigest ? { outputDigest: receipt.outputDigest } : {}),
    output,
    omittedFields: state.omitted,
  };
}

/** The result of one operation from its status and the receipts of its finished steps, in the order recorded. */
export function operationResultResource(
  operation: Pick<OperationStatus, "operationId" | "kind" | "state">,
  receipts: readonly DurableReceiptResource[],
): OperationResultResource {
  const ids = new Map<string, string[]>();
  const steps = receipts.map((receipt) => operationResultStep(receipt, ids));
  return {
    operationId: operation.operationId,
    kind: operation.kind,
    state: operation.state,
    steps,
    ids: Object.fromEntries(ids),
  };
}
