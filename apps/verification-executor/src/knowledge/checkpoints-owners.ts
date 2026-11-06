import { z } from "zod";
import type {
  CheckpointOperationReconciler,
  SourceDiscoveryApplicationService,
} from "@aiengineer/knowledge-application";
import type { ArtifactLedger } from "@aiengineer/knowledge-db";
import type { IngestionExecutor } from "@aiengineer/knowledge-db";
import type { GovernedIndexRepository, PostgresCanonicalRepository } from "@aiengineer/knowledge-persistence";
import type { FilesystemStore } from "../store.js";
import { validateStoredArtifact, type ArtifactCustody } from "../store-custody.js";

function receiptArtifactIds(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) receiptArtifactIds(item, found);
    return found;
  }
  if (!value || typeof value !== "object") return found;
  for (const [key, member] of Object.entries(value)) {
    if (/^(?:artifactId|.*ArtifactId|artifact_id)$/.test(key) && typeof member === "string")
      found.add(z.uuid().parse(member));
    else if (/ArtifactIds$/.test(key) && Array.isArray(member)) for (const id of member) found.add(z.uuid().parse(id));
    else receiptArtifactIds(member, found);
  }
  if (found.size > 1000) throw new Error("CHECKPOINT_OWNER_ARTIFACT_LIMIT");
  return found;
}

export function createCheckpointOwnerReconciler(input: {
  database: PostgresCanonicalRepository;
  store: FilesystemStore;
  artifacts: ArtifactLedger;
  custody: ArtifactCustody;
  publications: Pick<GovernedIndexRepository, "verifyPublication">;
  sourceDiscovery: SourceDiscoveryApplicationService;
  ingestion: IngestionExecutor;
}): CheckpointOperationReconciler {
  return {
    async reconcile({ tenantId, scope, operation }) {
      const unresolved = {
        ...operation,
        state: "unresolved" as const,
        artifacts: [],
        detail: "Original owner has no matching verified terminal outcome",
      };
      if (!z.uuid().safeParse(operation.operationId).success) return unresolved;
      let body: unknown;
      let outcome: "succeeded" | "failed" | "cancelled";
      if (operation.owner === "source_discovery") {
        let read = await input.sourceDiscovery.readAttempt(tenantId, operation.operationId);
        if (read.attempt.requestArtifact.digest !== operation.requestDigest) return unresolved;
        if (read.attempt.origin === "managed" && read.attempt.state === "started") {
          await input.sourceDiscovery.reconcileManaged(tenantId, operation.operationId);
          read = await input.sourceDiscovery.readAttempt(tenantId, operation.operationId);
        }
        if (read.attempt.state === "started" || read.attempt.state === "uncertain") return unresolved;
        return {
          ...operation,
          state: "settled",
          outcome: read.attempt.state,
          artifacts: [
            read.attempt.requestArtifact,
            ...[
              read.attempt.rawOutputArtifact,
              read.attempt.completionArtifact,
              read.attempt.externalReceiptArtifact,
            ].filter((value) => value !== undefined),
          ],
        };
      }
      if (operation.owner === "ingestion") {
        const receipt = await input.ingestion.receipt(operation.operationId, tenantId);
        if (receipt.intentRef.intentDigest !== operation.requestDigest || receipt.outcome === "partial")
          return unresolved;
        body = receipt;
        outcome = receipt.outcome === "rejected" ? "failed" : "succeeded";
      } else if (operation.owner === "verification" || operation.owner === "publication") {
        const current = await input.database.getOperationRecord(tenantId, operation.operationId);
        if (
          !current ||
          `sha256:${current.requestSha256}` !== operation.requestDigest ||
          !current.operationKind.startsWith(operation.owner)
        )
          return unresolved;
        if (current.status !== "succeeded") return unresolved;
        const receipts = await input.database.listReceipts(tenantId, operation.operationId);
        if (!receipts.length) return unresolved;
        // SV-17: the verification.v1 audit-bundle readback (evidence.verification_run) is retired with its AIDB
        // table; a verification owner settles on its terminal operation and receipts only.
        if (operation.owner === "verification") {
          body = { operation: current, receipts };
        } else {
          const publications = await input.database.transaction(
            tenantId,
            async (client) =>
              (
                await client.query<{ id: string }>(
                  "select id from retrieval.space_publication where tenant_id=$1 and operation_id=$2 order by id limit 2",
                  [tenantId, operation.operationId],
                )
              ).rows,
          );
          if (publications.length !== 1) return unresolved;
          const publication = await input.publications.verifyPublication(tenantId, publications[0]!.id);
          if (publication.publicationId !== publications[0]!.id || publication.status !== "published")
            return unresolved;
          body = { operation: current, receipts, publication };
        }
        for (const id of receiptArtifactIds(receipts.map((receipt) => receipt.body))) {
          const remote = await input.custody.resolve(id);
          if (remote) {
            if (remote.handle.artifactId !== id) throw new Error("CHECKPOINT_OWNER_ARTIFACT_BINDING_MISMATCH");
            validateStoredArtifact(tenantId, remote.handle, remote.bytes);
          } else await input.artifacts.reconcile({ tenantId, artifactId: id });
        }
        outcome = "succeeded";
      } else return unresolved;
      // Legacy receipt/report artifacts retain their canonical identities and reference guards.
      // This typed readback records the original owner's outcome using the existing custody client.
      const artifact = await input.store.putJson(
        { schemaVersion: "checkpoint-owner-readback.v1", scope, operation, outcome, body },
        {
          producerActivityId: `knowledge:checkpoint-owner:${operation.owner}:${operation.operationId}`,
          producerVersion: "checkpoint-owner-readback.v1",
          mediaType: "application/vnd.aiengineer.checkpoint-owner-readback+json",
          dataClassification: "internal",
          transformation: {
            owner: operation.owner,
            operationId: operation.operationId,
            requestDigest: operation.requestDigest,
          },
        },
      );
      return { ...operation, state: "settled", outcome, artifacts: [artifact.handle] };
    },
  };
}
