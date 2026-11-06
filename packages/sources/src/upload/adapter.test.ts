import { describe, expect, it } from "vitest";
import { digestBytes, InMemoryArtifactStore } from "@aiengineer/knowledge-core";
import { BoundedManualUploadAdapter, type ManualUploadRecord } from "./adapter.js";
import type { AcquisitionRequest } from "../types.js";

const bytes = (value: string) => new TextEncoder().encode(value);
function request(target: AcquisitionRequest["target"], maximumBytes = 10_000): AcquisitionRequest {
  return {
    tenantId: "tenant-1",
    purpose: "test",
    target,
    expectedSourceClass: "official",
    preferredMediaTypes: ["text/markdown"],
    egressProfile: "public-web",
    maximumBytes,
    renderingPolicy: "allowed",
    interactionPolicy: "none",
    classification: "public",
    expectedOutputs: ["source_native"],
  };
}

describe("BoundedManualUploadAdapter", () => {
  const attestation = {
    uploadId: "upload-1",
    origin: "console",
    method: "signed upload",
    acquiredAt: "2026-09-03T12:00:00Z",
    accessAndRightsContext: "owner supplied",
    automaticFailureReason: "",
  };
  function make(record: ManualUploadRecord, maximumBytes = 20) {
    return new BoundedManualUploadAdapter(
      new InMemoryArtifactStore(),
      { get: async () => record },
      { maximumBytes, maximumPathLength: 80, allowedMediaTypes: ["text/plain"] },
    );
  }
  async function execute(adapter: BoundedManualUploadAdapter, origin = "console", id = "u") {
    const plan = await adapter.plan(request({ kind: "upload", uploadId: "upload-1", declaredOrigin: origin }));
    return adapter.execute({ ...plan, admissionId: id });
  }
  it("bounds, attests, hashes, and stores uploads idempotently", async () => {
    const content = bytes("bounded");
    const adapter = make({
      uploadId: "upload-1",
      relativePath: "notes/source.txt",
      mediaType: "text/plain",
      bytes: content,
      declaredDigest: digestBytes(content),
      attestation,
    });
    const first = await execute(adapter);
    const second = await execute(adapter);
    expect(first.artifacts[0]?.artifactId).toBe(second.artifacts[0]?.artifactId);
    expect((await adapter.verify(first)).accepted).toBe(true);
  });
  it("rejects traversal, oversize, digest mismatch, and false origin", async () => {
    const base = {
      uploadId: "upload-1",
      relativePath: "safe.txt",
      mediaType: "text/plain",
      bytes: bytes("small"),
      attestation,
    };
    await expect(execute(make({ ...base, relativePath: "../secret.txt" }))).rejects.toThrow("UPLOAD_PATH_TRAVERSAL");
    await expect(execute(make({ ...base, bytes: bytes("large") }, 2))).rejects.toThrow("BYTE_LIMIT_EXCEEDED");
    await expect(execute(make({ ...base, declaredDigest: "sha256:bad" }))).rejects.toThrow("UPLOAD_DIGEST_MISMATCH");
    await expect(execute(make(base), "email")).rejects.toThrow("UPLOAD_ATTESTATION_INVALID");
  });
});
