import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { VerificationArtifactHandle } from "@aiengineer/knowledge-contracts";
import { FilesystemStore } from "./store.js";
import type { ArtifactCustody } from "./store-custody.js";

const tenantId = "00000000-0000-4000-8000-000000000001";
const input = (text: string) => ({
  bytes: new TextEncoder().encode(text),
  mediaType: "text/plain",
  producerActivityId: "test",
  producerVersion: "v1",
});
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function local(custody?: ArtifactCustody) {
  const dir = await mkdtemp(join(tmpdir(), "ks-custody-"));
  directories.push(dir);
  const store = new FilesystemStore(dir, tenantId);
  await store.init();
  if (custody) store.attachCustody(custody);
  return store;
}

function remote() {
  const handles = new Map<string, VerificationArtifactHandle>();
  const blobs = new Map<string, Uint8Array>();
  const custody: ArtifactCustody = {
    async lookup(id) {
      const handle = handles.get(id);
      return handle ? structuredClone(handle) : undefined;
    },
    async register(handle, bytes) {
      for (const parent of handle.parentArtifactIds) if (!handles.has(parent)) throw new Error("PARENT_UNAVAILABLE");
      const existing = handles.get(handle.artifactId);
      if (existing && JSON.stringify(existing) !== JSON.stringify(handle)) throw new Error("COLLISION");
      blobs.set(handle.digest, Uint8Array.from(bytes));
      handles.set(handle.artifactId, structuredClone(handle));
      return structuredClone(handle);
    },
    async resolve(id) {
      const handle = handles.get(id);
      if (!handle) return undefined;
      const bytes = blobs.get(handle.digest);
      if (!bytes) throw new Error("REMOTE_BYTES_UNAVAILABLE");
      return { handle: structuredClone(handle), bytes: Uint8Array.from(bytes) };
    },
  };
  return { custody, handles, blobs };
}

describe("executor logical artifact custody", () => {
  it("preserves distinct parents, producers and media types over deduplicated bytes after local destruction", async () => {
    const backing = remote(),
      producer = await local(backing.custody);
    const a = await producer.put(input("parent-a")),
      b = await producer.put(input("parent-b"));
    const first = await producer.put({
      ...input("same"),
      parentArtifactIds: [a.artifactId],
      transformation: { method: "extract" },
    });
    const second = await producer.put({
      ...input("same"),
      parentArtifactIds: [b.artifactId],
      transformation: { method: "extract" },
    });
    const third = await producer.put({ ...input("same"), producerActivityId: "another-producer" });
    const fourth = await producer.put({ ...input("same"), mediaType: "text/markdown" });
    expect(new Set([first, second, third, fourth].map((x) => x.artifactId)).size).toBe(4);
    expect(backing.blobs.size).toBe(3);
    await rm(producer.rootDir, { recursive: true });
    const consumer = await local(backing.custody);
    for (const original of [a, b, first, second, third, fourth]) {
      const restored = await consumer.resolveHandle({ artifactId: original.artifactId, digest: original.digest });
      expect(restored).toEqual(original);
      expect(await consumer.text(restored)).toBe(
        original.digest === a.digest ? "parent-a" : original.digest === b.digest ? "parent-b" : "same",
      );
    }
  });

  it("preserves existing capture and ancestor handles when remote custody is attached later", async () => {
    const store = await local(),
      backing = remote();
    const parent = await store.put(input("capture"));
    const child = await store.put({
      ...input("derived"),
      parentArtifactIds: [parent.artifactId],
      transformation: { v: 1 },
    });
    store.attachCustody(backing.custody);
    expect(await store.preserve(child.artifactId)).toEqual(child);
    expect([...backing.handles.keys()]).toEqual([parent.artifactId, child.artifactId]);
    expect(await store.put(input("capture"))).toEqual(parent);
  });

  it("restores original canonical digest keys and rejects a symlink ancestor before writing any bytes", async () => {
    const backing = remote(),
      producer = await local(backing.custody);
    const original = await producer.put(input("canonical audit"));
    const hex = original.digest.slice(7);
    const legacy = { ...original, objectKey: `${tenantId}/${hex.slice(0, 2)}/${hex}` };
    backing.handles.set(original.artifactId, legacy);
    const consumer = await local(backing.custody);
    expect(await consumer.resolveHandle({ artifactId: original.artifactId })).toEqual(legacy);
    expect(await consumer.text(legacy)).toBe("canonical audit");

    const blocked = await local(backing.custody),
      outside = await local();
    await symlink(outside.rootDir, join(blocked.rootDir, tenantId), process.platform === "win32" ? "junction" : "dir");
    const before = await readdir(outside.rootDir);
    await expect(blocked.resolveHandle({ artifactId: original.artifactId })).rejects.toThrow(
      "ARTIFACT_LOCAL_PATH_DENIED",
    );
    expect(await readdir(outside.rootDir)).toEqual(before);
    await expect(consumer.bytes({ ...legacy, objectKey: `${tenantId}/../${hex}` })).rejects.toThrow(
      "ARTIFACT_LOCAL_PATH_DENIED",
    );
  });

  it("does not acknowledge persistence on upload failure, and retries the original local identity", async () => {
    const backing = remote();
    let loseAck = true;
    const store = await local({
      ...backing.custody,
      async register(handle, bytes) {
        await backing.custody.register(handle, bytes);
        if (loseAck) {
          loseAck = false;
          throw new Error("ACK_LOST");
        }
        return handle;
      },
    });
    await expect(store.put(input("one"))).rejects.toThrow("ACK_LOST");
    const retry = await store.put(input("one"));
    expect(backing.handles.size).toBe(1);
    expect(backing.handles.get(retry.artifactId)).toEqual(retry);
  });

  it("rejects tampered bytes and mismatched combined references", async () => {
    const store = await local(),
      handle = await store.put(input("original"));
    await expect(
      store.resolveHandle({ artifactId: handle.artifactId, digest: `sha256:${"a".repeat(64)}` }),
    ).rejects.toThrow("ARTIFACT_REFERENCE_DIGEST_MISMATCH");
    await writeFile(join(store.rootDir, handle.objectKey), "tampered");
    await expect(store.bytes(handle)).rejects.toThrow("ARTIFACT_DIGEST_MISMATCH");
    await expect(store.bytes({ ...handle, objectKey: "../../secret" })).rejects.toThrow("ARTIFACT_LOCAL_PATH_DENIED");
  });

  it("fails clean restore when remote bytes or tenant binding are invalid", async () => {
    const backing = remote(),
      producer = await local(backing.custody);
    const handle = await producer.put(input("required"));
    const consumer = await local(backing.custody);
    backing.blobs.delete(handle.digest);
    await expect(consumer.resolveHandle({ artifactId: handle.artifactId })).rejects.toThrow("REMOTE_BYTES_UNAVAILABLE");
    backing.blobs.set(handle.digest, input("required").bytes);
    backing.handles.set(handle.artifactId, { ...handle, tenantId: "00000000-0000-4000-8000-000000000002" });
    await expect(consumer.resolveHandle({ artifactId: handle.artifactId })).rejects.toThrow("ARTIFACT_TENANT_MISMATCH");
  });

  it("reuses the original registration timestamp when a clean producer captures identical work", async () => {
    const backing = remote(),
      first = await local(backing.custody);
    const handle = await first.put({ ...input("capture"), createdAt: "2026-09-01T00:00:00.000Z" });
    const second = await local(backing.custody);
    expect(await second.put({ ...input("capture"), createdAt: "2026-09-02T00:00:00.000Z" })).toEqual(handle);
    expect(await readFile(join(second.rootDir, handle.objectKey), "utf8")).toBe("capture");
  });
});
