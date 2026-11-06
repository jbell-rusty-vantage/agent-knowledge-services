import { z } from "zod";
import { domainError, type CatalogEntry } from "../schema-workspace/index.js";
import { digestOf, type Digest } from "./canonical.js";
import { ReadIntentSchema, type OperationResult, type ReadSnapshot } from "./read-intent.js";

/** Catalog metadata, rather than query-name guesses, declares which clock a query supports. */
export function bindKnowledgeClock(
  entry: CatalogEntry,
  params: Record<string, unknown>,
  selected: number,
  current: number,
): Record<string, unknown> {
  const temporal = entry.temporal as { knowledge?: string } | undefined;
  const knowledge = temporal?.knowledge;
  if (knowledge === "param:k" || knowledge === "param:k_to") {
    const parameter = knowledge.slice(6);
    if (!entry.paramOrder.includes(parameter))
      throw domainError("HISTORICAL_QUERY_UNSUPPORTED", "Catalog clock parameter is not executable");
    const supplied = params[parameter];
    if (supplied !== undefined && supplied !== null && supplied !== selected)
      throw domainError("SNAPSHOT_CLOCK_CONFLICT", "Query clock conflicts with the selected snapshot clock");
    if (typeof params.k_from === "number" && params.k_from > selected)
      throw domainError("SNAPSHOT_CLOCK_CONFLICT", "Change interval starts after the selected clock");
    return { ...params, [parameter]: selected };
  }
  if (selected !== current && knowledge !== "n/a")
    throw domainError(
      "HISTORICAL_QUERY_UNSUPPORTED",
      `${entry.name} cannot execute at the selected historical knowledge clock`,
    );
  return params;
}

export function snapshotDigest(results: readonly OperationResult[], atKnowledgeSeq: number): Digest {
  return digestOf(
    results.map((result) => ({
      opId: result.opId,
      kind: result.kind,
      query: result.query ?? null,
      artifactId: result.artifactId ?? null,
      params: result.params ?? null,
      role: result.role ?? null,
      atKnowledgeSeq,
      status: result.status,
      truncated: result.truncated,
      rowCount: result.rowCount,
      reason: result.reason ?? null,
      contentDigest: result.volatile ? null : result.contentDigest,
    })),
  );
}

const Head = z.object({ knowledgeSeq: z.number().int().nonnegative(), updatedAt: z.string() });
const Snapshot = z.looseObject({
  schemaVersion: z.literal("knowledge-read-snapshot.v1"),
  snapshotId: z.string().uuid(),
  intentRef: z.object({ intentId: z.string(), intentDigest: z.string(), artifactId: z.string().uuid() }),
  context: z.looseObject({ tenantId: z.string().uuid() }),
  contract: z.looseObject({
    migrationHead: z.string(),
    workspaceFingerprint: z.string().optional(),
    staleWorkspace: z.unknown().optional(),
  }),
  knowledgeHead: Head,
  knowledgeHeadAfter: Head,
  headChanged: z.boolean(),
  atKnowledgeSeq: z.number().int().nonnegative(),
  snapshotDigest: z.string(),
  operations: z.array(
    z.looseObject({
      opId: z.string(),
      kind: z.enum(["named_query", "retrieval", "artifact"]),
      status: z.enum(["ok", "empty", "skipped", "error", "truncated"]),
      truncated: z.boolean(),
      rowCount: z.number().int().nonnegative(),
      contentDigest: z.string(),
      durationMs: z.number(),
    }),
  ),
});

export interface SnapshotExpectation {
  readonly tenantId: string;
  readonly snapshotId?: string;
  readonly snapshotDigest: string;
  readonly knowledgeSeq: number;
  readonly migrationHead: string;
  readonly workspaceFingerprint?: string;
}

/** Validate the persisted envelope against its original intent, not caller-supplied result summaries. */
export function validatePersistedSnapshot(
  raw: unknown,
  rawIntent: unknown,
  expected: SnapshotExpectation,
): ReadSnapshot {
  const parsed = Snapshot.safeParse(raw);
  const intent = ReadIntentSchema.safeParse(rawIntent);
  if (!parsed.success || !intent.success)
    throw domainError("SNAPSHOT_INVALID", "Persisted snapshot or read intent has an invalid schema");
  const snapshot = parsed.data as unknown as ReadSnapshot;
  if (snapshot.context.tenantId !== expected.tenantId || intent.data.context.tenantId !== expected.tenantId)
    throw domainError("SNAPSHOT_UNAVAILABLE", "Snapshot is unavailable for this tenant");
  if (
    snapshot.contract.migrationHead !== expected.migrationHead ||
    (expected.workspaceFingerprint && snapshot.contract.workspaceFingerprint !== expected.workspaceFingerprint) ||
    parsed.data.contract.staleWorkspace
  )
    throw domainError("SNAPSHOT_CONTRACT_MISMATCH", "Snapshot contract does not match the executor");
  if (
    (expected.snapshotId && expected.snapshotId !== snapshot.snapshotId) ||
    snapshot.snapshotDigest !== expected.snapshotDigest ||
    snapshotDigest(snapshot.operations, snapshot.atKnowledgeSeq) !== snapshot.snapshotDigest ||
    snapshot.intentRef.intentDigest !== digestOf(rawIntent) ||
    snapshot.intentRef.intentId !== intent.data.intentId
  )
    throw domainError("SNAPSHOT_DIGEST_MISMATCH", "Snapshot does not match its bound intent and digest");
  if (
    snapshot.headChanged ||
    snapshot.knowledgeHead.knowledgeSeq !== snapshot.knowledgeHeadAfter.knowledgeSeq ||
    snapshot.atKnowledgeSeq !== expected.knowledgeSeq ||
    snapshot.atKnowledgeSeq > snapshot.knowledgeHead.knowledgeSeq ||
    (intent.data.atKnowledgeSeq ?? snapshot.knowledgeHead.knowledgeSeq) !== snapshot.atKnowledgeSeq
  )
    throw domainError("SNAPSHOT_CLOCK_CONFLICT", "Snapshot does not have one consistent selected knowledge clock");
  if (snapshot.operations.length !== intent.data.operations.length)
    throw domainError("SNAPSHOT_INCOMPLETE", "Snapshot omits requested operations");
  for (const [index, operation] of intent.data.operations.entries()) {
    const result = snapshot.operations[index]!;
    if (result.opId !== operation.opId || result.kind !== operation.kind)
      throw domainError("SNAPSHOT_INCOMPLETE", "Snapshot operation identity does not match the read intent");
    if (operation.kind === "artifact" && result.status === "ok" && result.artifactId !== operation.artifactId)
      throw domainError("SNAPSHOT_DIGEST_MISMATCH", "Snapshot artifact operation refers to different bytes");
    if (
      operation.kind === "named_query" &&
      ["ok", "empty", "truncated"].includes(result.status) &&
      result.query !== operation.query.replace(/^q:/, "")
    )
      throw domainError("SNAPSHOT_DIGEST_MISMATCH", "Snapshot query differs from its read intent");
    if (operation.required && (result.truncated || !["ok", "empty"].includes(result.status)))
      throw domainError("SNAPSHOT_INCOMPLETE", `Required operation ${operation.opId} did not complete`);
    const content = result.rows ?? result.value;
    if (result.kind !== "artifact" && content !== undefined && digestOf(content) !== result.contentDigest)
      throw domainError("SNAPSHOT_DIGEST_MISMATCH", "Snapshot result content differs from its digest");
  }
  return snapshot;
}
