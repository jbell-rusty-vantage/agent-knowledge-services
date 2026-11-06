import { describe, expect, it } from "vitest";
import {
  CheckpointCommitRequestSchema,
  CheckpointManifestSchema,
  CheckpointRelativePathSchema,
  CheckpointScopeSchema,
} from "./checkpoints.js";
const tenantId = "11111111-1111-4111-8111-111111111111";
const scope = {
  tenantId,
  runId: "run",
  producerAttemptId: "attempt",
  sessionId: "session",
  sandboxId: "sandbox",
  namespace: "root",
};
const pins = {
  storageProfileVersion: "v1",
  storageProfileDigest: `sha256:${"a".repeat(64)}`,
  retentionPolicyVersion: "v1",
  retentionPolicyDigest: `sha256:${"b".repeat(64)}`,
  capabilityProfileVersion: "v1",
  capabilityProfileDigest: `sha256:${"c".repeat(64)}`,
};
const manifest = {
  schemaVersion: "scoped-checkpoint.v1",
  scope,
  parentCheckpointId: null,
  ...pins,
  mode: "archive",
  boundary: "dirty_interval",
  files: [],
  requiredArtifacts: [],
  pendingOperations: [],
};
describe("checkpoint contracts", () => {
  it.each(["../secret", "/tmp/file", "notes/../secret", "notes\\file", "C:/secret", "notes//file"])(
    "rejects noncanonical path %s",
    (path) => expect(CheckpointRelativePathSchema.safeParse(path).success).toBe(false),
  );
  it("requires both real child and parent identities", () => {
    expect(CheckpointScopeSchema.safeParse({ ...scope, childId: "child" }).success).toBe(false);
    expect(CheckpointScopeSchema.safeParse({ ...scope, parentScopeId: tenantId, childId: "child" }).success).toBe(true);
  });
  it("separates archive from continuation and binds head to parent", () => {
    expect(CheckpointManifestSchema.safeParse(manifest).success).toBe(true);
    expect(CheckpointManifestSchema.safeParse({ ...manifest, mode: "continuation" }).success).toBe(false);
    expect(
      CheckpointCommitRequestSchema.safeParse({ idempotencyKey: "key", expectedHead: tenantId, manifest }).success,
    ).toBe(false);
  });
});
