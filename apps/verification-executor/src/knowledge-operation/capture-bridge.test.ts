import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { expect, it } from "vitest";
import type { VerificationArtifactHandle } from "@aiengineer/knowledge-contracts";
import type { AuthScope } from "@aiengineer/knowledge-research-core";
import { captureFile } from "../capture.js";
import { FilesystemStore, type CaptureRecord } from "../store.js";
import { captureFragment, createCaptureCustodyReader, readCaptureProvenance } from "./capture-bridge.js";

/** Removes a test root, refusing any path outside the OS temp directory. */
async function removeTempRoot(root: string): Promise<void> {
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("TEST_CLEANUP_PATH_DENIED");
  await rm(root, { recursive: true, force: true });
}

it("maps actual capture identities, reconstructs exact bytes, and refuses digest/scope/selector drift", async () => {
  const root = await mkdtemp(join(tmpdir(), "ks-capture-bridge-"));
  // Unit backing double only; the real storage fixture supplies the integration proof.
  const backing = new Map<string, { handle: VerificationArtifactHandle; bytes: Uint8Array }>();
  const tenant = "00000000-0000-4000-8000-000000000001";
  const scope = {
    tenant,
    application: "ai-engineer",
    binding: "aiengineer-postgres",
    grants: [],
  } as unknown as AuthScope;
  const open = async (name: string) => {
    const store = new FilesystemStore(join(root, name), tenant);
    await store.init();
    store.attachCustody({
      lookup: async (id) => backing.get(id)?.handle,
      resolve: async (id) => backing.get(id),
      register: async (handle, bytes) => {
        backing.set(handle.artifactId, { handle, bytes });
        return handle;
      },
    });
    return store;
  };
  try {
    const producer = await open("producer");
    const source = "Model X has 7B parameters.\nWeights are distributed under a research license.\n";
    const captured = await captureFile(producer, {
      bytes: Buffer.from(source),
      filename: "model.md",
      sourceUri: "https://fixture.invalid/model",
    });
    const request = {
      id: "model-fragment",
      captureId: captured.record.captureId,
      representationDigest: captured.record.contentArtifact.digest,
      quote: "Model X has 7B parameters.",
      access: { rights: "public" as const, limits: [] },
    };
    const first = await captureFragment(producer, scope, request);
    expect(await captureFragment(producer, scope, request)).toEqual(first);
    expect(first.fragment.capture.id).toBe(captured.record.contentArtifact.artifactId);
    expect(first.fragment.sourceVersion).toBe(first.provenance.artifactId);
    for (const changed of [
      { requestedUrl: "https://wrong.invalid/" },
      { finalUrl: "https://wrong.invalid/" },
      { title: "fabricated title" },
    ]) {
      await producer.writeCapture({ ...captured.record, ...changed });
      await expect(captureFragment(producer, scope, request)).rejects.toThrow("ACQUISITION_METADATA_MISMATCH");
    }
    await producer.writeCapture(captured.record);
    await expect(captureFragment(producer, scope, { ...request, representationDigest: "" })).rejects.toThrow(
      "DIGEST_REQUIRED",
    );
    await expect(
      captureFragment(producer, scope, { ...request, representationDigest: `sha256:${"0".repeat(64)}` }),
    ).rejects.toThrow("DIGEST_MISMATCH");
    await expect(captureFragment(producer, scope, { ...request, quote: "9B" })).rejects.toThrow("SELECTOR_NOT_FOUND");
    const producerPath = resolve(producer.rootDir);
    if (!producerPath.startsWith(resolve(root) + sep)) throw new Error("TEST_CLEANUP_PATH_DENIED");
    await rm(producerPath, { recursive: true });
    const readerStore = await open("reader"),
      reader = createCaptureCustodyReader(readerStore);
    expect(Buffer.from((await reader.get(scope, first.fragment.representation))!).toString()).toBe(source);
    const provenance = await readerStore.resolveHandle({
      artifactId: first.provenance.artifactId,
      digest: first.provenance.digest,
    });
    expect((await readerStore.json<CaptureRecord>(provenance)).captureId).toBe(captured.record.captureId);
    expect((await readCaptureProvenance(readerStore, scope, first.fragment.sourceVersion)).captureId).toBe(
      captured.record.captureId,
    );
    await expect(reader.get(scope, { ...first.fragment.capture, digest: `sha256:${"0".repeat(64)}` })).rejects.toThrow(
      "DIGEST_MISMATCH",
    );
    await expect(reader.get(scope, { ...first.fragment.capture, binding: "biotech-graph" })).rejects.toThrow(
      "SCOPE_MISMATCH",
    );
    await expect(reader.get({ ...scope, tenant: "another" }, first.fragment.capture)).rejects.toThrow("SCOPE_MISMATCH");
    await expect(reader.get(scope, { ...first.fragment.capture, digest: undefined } as never)).rejects.toThrow();
  } finally {
    await removeTempRoot(root);
  }
});
