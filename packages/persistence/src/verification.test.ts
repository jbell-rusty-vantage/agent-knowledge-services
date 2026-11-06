import { describe, expect, it, vi } from "vitest";
import { InMemoryArtifactStore } from "@aiengineer/knowledge-core";
import type { PostgresCanonicalRepository } from "./postgres.js";
import { createVerificationArtifactHandle, PostgresVerificationRepository } from "./verification.js";

describe("verification artifact timestamp identity", () => {
  const bytes = new TextEncoder().encode("timestamp fixture");
  const base = {
    tenantId: "11111111-1111-4111-8111-111111111111",
    bytes,
    mediaType: "text/plain",
    producerActivityId: "test",
    producerVersion: "1",
    encryptionClass: "managed",
    retentionClass: "test",
    dataClassification: "internal" as const,
  };

  it("normalizes factory timestamps to the database round-trip representation", () => {
    expect(createVerificationArtifactHandle({ ...base, createdAt: "2026-09-05T00:00:00Z" }).createdAt).toBe(
      "2026-09-05T00:00:00.000Z",
    );
  });

  it("rejects externally supplied noncanonical timestamps before SQL", async () => {
    const canonical = createVerificationArtifactHandle({ ...base, createdAt: "2026-09-05T00:00:00.000Z" });
    const transaction = vi.fn(async () => {
      throw new Error("SQL_MUST_NOT_RUN");
    });
    const repository = new PostgresVerificationRepository(
      { transaction } as unknown as PostgresCanonicalRepository,
      new InMemoryArtifactStore(),
      { async authorize() {} },
    );
    await expect(
      repository.registerArtifact({
        handle: { ...canonical, createdAt: "2026-09-05T00:00:00Z" },
        bytes,
        artifactType: "source_capture",
        bucketClass: "source_captures",
        storageBucket: "test",
      }),
    ).rejects.toThrow("ARTIFACT_CREATED_AT_NOT_CANONICAL");
    expect(transaction).not.toHaveBeenCalled();
  });
});
