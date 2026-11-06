import { z } from "zod";
import {
  ReadIntentSchema,
  validatePersistedSnapshot,
  type ArtifactLedger,
  type ReadSnapshot,
} from "../db-read/index.js";
import { domainError, type Workspace } from "../schema-workspace/index.js";

export interface SnapshotPreflightInput {
  readonly context: { readonly tenantId: string };
  readonly inputSnapshot?:
    | {
        readonly artifactId?: string | undefined;
        readonly snapshotId?: string | undefined;
        readonly snapshotDigest: string;
        readonly knowledgeSeq: number;
      }
    | undefined;
  readonly expectedKnowledgeHead?: number | undefined;
}

const SnapshotIntentLink = z.looseObject({ intentRef: z.looseObject({ artifactId: z.string().uuid() }) });

export async function verifySnapshotPreflight(
  input: SnapshotPreflightInput,
  artifacts: ArtifactLedger,
  workspace: Workspace,
): Promise<ReadSnapshot> {
  const reference = input.inputSnapshot;
  if (!reference?.artifactId)
    throw domainError("SNAPSHOT_REQUIRED", "Ingestion requires a persisted read snapshot artifact");
  if (input.expectedKnowledgeHead !== undefined && input.expectedKnowledgeHead !== reference.knowledgeSeq)
    throw domainError("SNAPSHOT_CLOCK_CONFLICT", "Expected knowledge head contradicts the input snapshot");
  const tenantId = input.context.tenantId;
  const stored = await artifacts.get(tenantId, reference.artifactId);
  if (stored.record.artifactType !== "knowledge_read_snapshot" || stored.json === undefined)
    throw domainError(
      "SNAPSHOT_UNAVAILABLE",
      "Persisted snapshot bytes are unavailable or have the wrong artifact type",
    );
  const link = SnapshotIntentLink.safeParse(stored.json);
  if (!link.success) throw domainError("SNAPSHOT_INVALID", "Persisted snapshot has no valid read intent artifact");
  const original = await artifacts.get(tenantId, link.data.intentRef.artifactId);
  if (original.record.artifactType !== "knowledge_read_intent" || original.json === undefined)
    throw domainError(
      "SNAPSHOT_UNAVAILABLE",
      "Original read intent bytes are unavailable or have the wrong artifact type",
    );
  const snapshot = validatePersistedSnapshot(stored.json, original.json, {
    tenantId,
    snapshotDigest: reference.snapshotDigest,
    knowledgeSeq: reference.knowledgeSeq,
    ...(reference.snapshotId ? { snapshotId: reference.snapshotId } : {}),
    migrationHead: workspace.migrationHead,
    ...(workspace.fingerprint ? { workspaceFingerprint: workspace.fingerprint } : {}),
  });
  if (
    !ReadIntentSchema.parse(original.json).operations.some(
      (operation) => operation.kind === "named_query" && operation.required,
    )
  )
    throw domainError("SNAPSHOT_INCOMPLETE", "Ingestion preflight requires at least one required database read");
  return snapshot;
}
