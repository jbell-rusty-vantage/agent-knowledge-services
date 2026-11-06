import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Digest } from "../domain/index.js";
import {
  InMemoryArtifactStore,
  InMemoryOperationLedger,
  LocalArtifactStore,
  SupabaseArtifactStore,
  digestBytes,
} from "./index.js";

const context = {
  tenantId: "tenant-1",
  operationId: "op-1",
  attemptId: "attempt-1",
  correlationId: "corr-1",
  actor: "executor_service",
  capabilityVersion: "v1",
};
describe("in-memory durable primitives", () => {
  it("content-addresses and isolates artifacts", async () => {
    const store = new InMemoryArtifactStore();
    const bytes = new TextEncoder().encode("same");
    const a = await store.put({ tenantId: "tenant-1", mediaType: "text/plain", bytes });
    const b = await store.put({ tenantId: "tenant-1", mediaType: "text/plain", bytes });
    expect(a.artifactId).toBe(b.artifactId);
    expect(a.digest).toBe(digestBytes(bytes));
    expect(await store.get("tenant-2", a.digest)).toBeUndefined();
  });
  it("round-trips the local content-addressed implementation", async () => {
    const root = await mkdtemp(join(tmpdir(), "knowledge-artifacts-"));
    try {
      const store = new LocalArtifactStore(root);
      const bytes = new TextEncoder().encode("sealed");
      const artifact = await store.put({ tenantId: "tenant-1", mediaType: "text/plain", bytes });
      await store.put({ tenantId: "tenant-1", mediaType: "text/plain", bytes });
      expect(await store.get("tenant-1", artifact.digest)).toEqual(bytes);
      await expect(store.get("../escape", artifact.digest)).rejects.toThrow("Unsafe");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("detects local artifact tampering on read and idempotent write", async () => {
    const root = await mkdtemp(join(tmpdir(), "knowledge-artifacts-"));
    try {
      const store = new LocalArtifactStore(root);
      const bytes = new TextEncoder().encode("sealed");
      const artifact = await store.put({ tenantId: "tenant-1", mediaType: "text/plain", bytes });
      await writeFile(artifact.storageKey, "tampered");
      await expect(store.get("tenant-1", artifact.digest)).rejects.toThrow("ARTIFACT_DIGEST_MISMATCH");
      await expect(store.put({ tenantId: "tenant-1", mediaType: "text/plain", bytes })).rejects.toThrow(
        "ARTIFACT_DIGEST_MISMATCH",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("uses private digest-addressed Supabase objects without exposing credentials", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const bytes = new TextEncoder().encode("remote sealed");
    const digest = digestBytes(bytes);
    const fetcher = async (url: string, init?: RequestInit) => {
      requests.push(init === undefined ? { url } : { url, init });
      return init?.method === "POST"
        ? new Response(null, { status: 200 })
        : new Response(bytes, { status: 200, headers: { "content-length": String(bytes.length) } });
    };
    const store = new SupabaseArtifactStore(
      {
        projectUrl: "https://project.supabase.co",
        serviceRoleKey: "test-only-secret",
        bucket: "knowledge-source-private",
        maximumBytes: 100,
      },
      fetcher,
    );
    const artifact = await store.put({ tenantId: "tenant-1", mediaType: "text/plain", bytes });
    expect(artifact.digest).toBe(digest);
    expect(artifact.storageKey).toMatch(/^tenant-1\/[a-f0-9]{2}\/[a-f0-9]{64}$/);
    expect(await store.get("tenant-1", digest)).toEqual(bytes);
    expect(requests.every(({ url }) => !url.includes("test-only-secret"))).toBe(true);
    expect(new Headers(requests[0]!.init?.headers).get("x-upsert")).toBe("false");
  });
  it("verifies local Storage's 400 duplicate response as an idempotent replay", async () => {
    const bytes = new TextEncoder().encode("already stored");
    const store = new SupabaseArtifactStore(
      {
        projectUrl: "http://127.0.0.1:54321",
        serviceRoleKey: "local-secret",
        bucket: "source-captures",
        maximumBytes: 100,
      },
      async (_url, init) =>
        init?.method === "POST"
          ? new Response('{"message":"The resource already exists"}', { status: 400 })
          : new Response(bytes, { status: 200 }),
    );
    await expect(store.put({ tenantId: "tenant-1", mediaType: "text/plain", bytes })).resolves.toMatchObject({
      digest: digestBytes(bytes),
    });
  });
  it("fails closed on missing collision metadata without an overwrite", async () => {
    const bytes = new TextEncoder().encode("orphaned after reset");
    const upserts: string[] = [];
    const store = new SupabaseArtifactStore(
      {
        projectUrl: "http://127.0.0.1:54321",
        serviceRoleKey: "local-secret",
        bucket: "source-captures",
        maximumBytes: 100,
      },
      async (_url, init) => {
        if (init?.method === "POST") {
          upserts.push(new Headers(init.headers).get("x-upsert") ?? "");
          return new Response(null, { status: 400 });
        }
        return new Response('{"statusCode":"400"}', { status: 400 });
      },
    );
    await expect(store.put({ tenantId: "tenant-1", mediaType: "text/plain", bytes })).rejects.toThrow(
      "SUPABASE_STORAGE_DOWNLOAD_FAILED:400",
    );
    expect(upserts).toEqual(["false"]);
  });
  it("repairs stale local Storage metadata only when explicitly enabled", async () => {
    const bytes = new TextEncoder().encode("orphaned after reset");
    let posts = 0;
    const upserts: string[] = [];
    const store = new SupabaseArtifactStore(
      {
        projectUrl: "http://127.0.0.1:54321",
        serviceRoleKey: "local-secret",
        bucket: "source-captures",
        maximumBytes: 100,
        collisionRecovery: "repair_missing_metadata",
      },
      async (_url, init) => {
        if (init?.method === "POST") {
          posts++;
          upserts.push(new Headers(init.headers).get("x-upsert") ?? "");
          return new Response(null, { status: posts === 1 ? 400 : 200 });
        }
        return posts === 1
          ? new Response('{"statusCode":"400"}', { status: 400 })
          : new Response(bytes, { status: 200 });
      },
    );
    await expect(store.put({ tenantId: "tenant-1", mediaType: "text/plain", bytes })).resolves.toMatchObject({
      digest: digestBytes(bytes),
    });
    expect(upserts).toEqual(["false", "true"]);
  });
  it("rejects Supabase path traversal, oversize content and remote digest mismatch", async () => {
    const store = new SupabaseArtifactStore(
      {
        projectUrl: "https://project.supabase.co",
        serviceRoleKey: "secret",
        bucket: "knowledge-source-private",
        maximumBytes: 4,
      },
      async () => new Response("evil", { status: 200 }),
    );
    await expect(
      store.put({ tenantId: "../tenant", mediaType: "text/plain", bytes: new Uint8Array([1]) }),
    ).rejects.toThrow("Unsafe");
    await expect(store.put({ tenantId: "tenant", mediaType: "text/plain", bytes: new Uint8Array(5) })).rejects.toThrow(
      "SIZE_LIMIT",
    );
    await expect(store.get("tenant", digestBytes(new TextEncoder().encode("good")))).rejects.toThrow("DIGEST_MISMATCH");
  });
  it("deduplicates operations and activity receipts", () => {
    const ledger = new InMemoryOperationLedger({ now: () => new Date("2026-01-01T00:00:00Z") });
    const first = ledger.create(context, "prepare:one", { source: "one" }, ["acquire"]);
    expect(ledger.create(context, "prepare:one", { source: "one" }, ["ignored"])).toEqual(first);
    const step = ledger.claim("op-1", "worker", 1_000)!;
    const receipt = ledger.complete("op-1", step.id, step.leaseToken!, first.inputDigest, { artifact: "x" });
    expect(ledger.complete("op-1", step.id, "irrelevant", first.inputDigest, { artifact: "x" })).toEqual(receipt);
    expect(ledger.get("op-1")?.state).toBe("succeeded");
    expect(ledger.events("op-1").map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
  });
  it("rejects operation identity reuse under another idempotency key", () => {
    const ledger = new InMemoryOperationLedger();
    ledger.create(context, "first-key", { source: "one" }, ["acquire"]);
    expect(() => ledger.create(context, "second-key", { source: "two" }, ["convert"])).toThrow("IDEMPOTENCY_CONFLICT");
    expect(ledger.get("op-1")?.inputDigest).toBe(sha256Digest({ source: "one" }));
  });
  it("reclaims expired leases", () => {
    let time = 0;
    const ledger = new InMemoryOperationLedger({ now: () => new Date(time) });
    ledger.create(context, "prepare:two", { source: "two" }, ["convert"]);
    const first = ledger.claim("op-1", "dead-worker", 10)!;
    time = 11;
    const second = ledger.claim("op-1", "new-worker", 10)!;
    expect(second.id).toBe(first.id);
    expect(second.attempts).toBe(2);
    expect(() => ledger.heartbeat("op-1", first.id, first.leaseToken!, 10)).toThrow("STALE_LEASE");
  });
});
