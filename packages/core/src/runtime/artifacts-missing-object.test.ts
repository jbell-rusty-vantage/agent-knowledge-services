import { describe, expect, it } from "vitest";
import { SupabaseArtifactStore } from "./artifacts.js";

const digest = `sha256:${"a".repeat(64)}` as const;
const store = (body: unknown) =>
  new SupabaseArtifactStore(
    { projectUrl: "https://example.invalid", serviceRoleKey: "test", bucket: "proof", maximumBytes: 1024 },
    async () => new Response(JSON.stringify(body), { status: 400 }),
  );
describe("Supabase structured missing objects", () => {
  it("recognizes the Storage NoSuchKey 404 carried by HTTP 400", async () => {
    expect(
      await store({ statusCode: "404", error: "not_found", code: "NoSuchKey" }).get("tenant", digest),
    ).toBeUndefined();
  });
  it("does not turn a missing bucket, denied request or generic 400 into a cache miss", async () => {
    for (const body of [
      { statusCode: "404", code: "NoSuchBucket" },
      { statusCode: "403", code: "NoSuchKey" },
      { error: "bad_request" },
    ]) {
      await expect(store(body).get("tenant", digest)).rejects.toThrow("SUPABASE_STORAGE_DOWNLOAD_FAILED:400");
    }
  });
});
