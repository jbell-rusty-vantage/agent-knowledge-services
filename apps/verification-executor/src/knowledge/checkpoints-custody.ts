import { CheckpointSemanticHandoffSchema } from "@aiengineer/knowledge-contracts";
import { checkpointScopeId, type CheckpointCustody } from "@aiengineer/knowledge-application";
import { canonicalizeJson } from "@aiengineer/knowledge-verification";
import { validateExecutorCheckpointState } from "../checkpoint-state.js";
import { assertSameArtifact, validateStoredArtifact, type ArtifactCustody } from "../store-custody.js";
import type { FilesystemStore } from "../store.js";

export function createCheckpointCustody(store: FilesystemStore, custody: ArtifactCustody): CheckpointCustody {
  const requireTenant = (tenantId: string) => {
    if (tenantId !== store.tenantId) throw new Error("CHECKPOINT_TENANT_DENIED");
  };
  return {
    async resolve({ tenantId, artifactId }) {
      requireTenant(tenantId);
      const artifact = await custody.resolve(artifactId);
      if (artifact) validateStoredArtifact(tenantId, artifact.handle, artifact.bytes);
      return artifact;
    },
    async registerManifest({ tenantId, manifest, bytes, parentArtifactIds }) {
      requireTenant(tenantId);
      if (manifest.scope.tenantId !== tenantId) throw new Error("CHECKPOINT_TENANT_DENIED");
      return store.put({
        bytes,
        mediaType: "application/vnd.aiengineer.scoped-checkpoint+json",
        producerActivityId: `knowledge:checkpoint:${checkpointScopeId(manifest.scope)}`,
        producerVersion: "scoped-checkpoint.v1",
        dataClassification: "internal",
        parentArtifactIds,
        transformation: {
          kind: "scoped-checkpoint",
          scope: manifest.scope,
          parentCheckpointId: manifest.parentCheckpointId,
        },
      });
    },
    async validateExecutorState({ tenantId, scope, artifact }) {
      requireTenant(tenantId);
      await validateExecutorCheckpointState(custody, { tenantId, scopeId: checkpointScopeId(scope), artifact });
    },
    async validateSemanticHandoff({ tenantId, scope, artifact, pendingOperations }) {
      requireTenant(tenantId);
      const stored = await custody.resolve(artifact.artifactId);
      if (!stored) throw new Error("CHECKPOINT_HANDOFF_UNAVAILABLE");
      assertSameArtifact(artifact, stored.handle);
      validateStoredArtifact(tenantId, stored.handle, stored.bytes);
      const handoff = CheckpointSemanticHandoffSchema.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(stored.bytes)),
      );
      if (
        canonicalizeJson(handoff.scope) !== canonicalizeJson(scope) ||
        canonicalizeJson(handoff.pendingOperations) !== canonicalizeJson(pendingOperations) ||
        handoff.status !== (pendingOperations.length ? "partial" : "ready_for_continuation") ||
        artifact.mediaType !== "application/vnd.aiengineer.checkpoint-handoff+json" ||
        canonicalizeJson(artifact.parentArtifactIds) !== canonicalizeJson([handoff.notesArtifact.artifactId])
      ) {
        throw new Error("CHECKPOINT_HANDOFF_BINDING");
      }
      const notes = await custody.resolve(handoff.notesArtifact.artifactId);
      if (!notes) throw new Error("CHECKPOINT_HANDOFF_NOTES_UNAVAILABLE");
      assertSameArtifact(handoff.notesArtifact, notes.handle);
      validateStoredArtifact(tenantId, notes.handle, notes.bytes);
      if (notes.bytes.byteLength > 1_000_000 || !new TextDecoder("utf-8", { fatal: true }).decode(notes.bytes).trim()) {
        throw new Error("CHECKPOINT_HANDOFF_NOTES_INVALID");
      }
    },
  };
}
