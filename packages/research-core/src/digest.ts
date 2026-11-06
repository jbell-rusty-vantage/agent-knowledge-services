import {
  type Digest,
  type JsonValue,
  type Ref,
  type RefKind,
  digestCanonical,
  sameRef,
} from "@aiengineer/knowledge-operation-protocol";
import type { RecordIdentity } from "./records/common.js";

/** Digest of a record's canonical bytes. Records are immutable, so the digest excludes nothing. */
export function recordDigest<R extends RecordIdentity>(record: R): Digest {
  return digestCanonical(record as unknown as JsonValue);
}

/** Build the K01 `Ref` naming an immutable record: identity fields plus the digest of the whole record. */
export function recordRef<K extends RefKind, R extends RecordIdentity>(kind: K, record: R): Ref<K> {
  return {
    kind,
    id: record.id,
    version: record.schemaVersion,
    digest: recordDigest(record),
    tenant: record.tenant,
    binding: record.binding,
  };
}

export class RefMismatchError extends Error {
  readonly code = "REF_MISMATCH" as const;
  constructor(expected: Ref, actual: Ref) {
    super(`expected ${refKey(expected)}, got ${refKey(actual)}`);
    this.name = "RefMismatchError";
  }
}

export function assertSameRef(expected: Ref, actual: Ref): void {
  if (!sameRef(expected, actual)) throw new RefMismatchError(expected, actual);
}

/** A stable string key for maps and ordering; includes every Ref field. */
export function refKey(ref: Ref): string {
  return `${ref.kind}|${ref.tenant}|${ref.binding}|${ref.id}|${ref.version}|${ref.digest}`;
}

export type StoreScope = { readonly tenant: string; readonly binding: string };

export function inScope(ref: Ref, scope: StoreScope): boolean {
  return ref.tenant === scope.tenant && ref.binding === scope.binding;
}

/** Deduplicate refs by full identity and order them deterministically. */
export function uniqueRefs<K extends RefKind>(refs: readonly Ref<K>[]): Ref<K>[] {
  const byKey = new Map<string, Ref<K>>();
  for (const ref of refs) byKey.set(refKey(ref), ref);
  return [...byKey.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, ref]) => ref);
}
