import { describe, expect, it, vi } from "vitest";
import { PostgresVectorSearchBackend } from "./postgres.js";

const embedding = () => [1, ...Array(1_535).fill(0)];

describe("PostgresVectorSearchBackend", () => {
  it("calls the authoritative RPC and maps its typed result", async () => {
    const rpc = vi.fn(async () => ({
      data: [
        { vector_item_id: "item-1", search_projection_id: "projection-1", score: 0.75, search_text: "durable state" },
      ],
      error: null,
    }));
    const tenantCheck = vi.fn();
    const backend = new PostgresVectorSearchBackend({ rpc }, tenantCheck);
    await expect(
      backend.search({ tenantId: "tenant-1", vectorSpaceVersionId: "version-1", embedding: embedding(), limit: 5 }),
    ).resolves.toEqual([
      { vectorItemId: "item-1", searchProjectionId: "projection-1", score: 0.75, searchText: "durable state" },
    ]);
    expect(tenantCheck).toHaveBeenCalledWith("tenant-1");
    expect(rpc).toHaveBeenCalledWith(
      "search_knowledge_1536",
      expect.objectContaining({
        p_vector_space_version_id: "version-1",
        p_limit: 5,
        p_query: expect.stringMatching(/^\[1,0,/),
      }),
    );
  });

  it("surfaces database failures and rejects malformed responses", async () => {
    const failing = new PostgresVectorSearchBackend({
      rpc: async () => ({ data: null, error: { code: "42501", message: "tenant denied" } }),
    });
    await expect(
      failing.search({ tenantId: "t", vectorSpaceVersionId: "v", embedding: embedding(), limit: 1 }),
    ).rejects.toMatchObject({ code: "42501" });
    const malformed = new PostgresVectorSearchBackend({
      rpc: async () => ({ data: [{ vector_item_id: "x", score: Number.NaN }], error: null }),
    });
    await expect(
      malformed.search({ tenantId: "t", vectorSpaceVersionId: "v", embedding: embedding(), limit: 1 }),
    ).rejects.toMatchObject({ code: "INVALID_RPC_RESPONSE" });
  });
});
