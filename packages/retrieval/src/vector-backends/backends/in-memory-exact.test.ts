import { describe, expect, it } from "vitest";
import { InMemoryExactCosineBackend } from "./in-memory-exact.js";

const vector = (entries: Readonly<Record<number, number>>) => {
  const value = Array.from({ length: 1_536 }, () => 0);
  for (const [index, component] of Object.entries(entries)) value[Number(index)] = component;
  return value;
};

describe("InMemoryExactCosineBackend", () => {
  it("performs deterministic exact cosine search with tenant, version, and lifecycle isolation", async () => {
    const backend = new InMemoryExactCosineBackend([
      {
        tenantId: "t1",
        vectorSpaceVersionId: "v1",
        vectorSpaceKey: "claims",
        vectorItemId: "b",
        searchProjectionId: "p2",
        embedding: vector({ 0: 1 }),
        searchText: "best",
      },
      {
        tenantId: "t1",
        vectorSpaceVersionId: "v1",
        vectorSpaceKey: "claims",
        vectorItemId: "a",
        embedding: vector({ 0: 1 }),
      },
      {
        tenantId: "t1",
        vectorSpaceVersionId: "v1",
        vectorSpaceKey: "claims",
        vectorItemId: "c",
        embedding: vector({ 1: 1 }),
      },
      {
        tenantId: "t2",
        vectorSpaceVersionId: "v1",
        vectorSpaceKey: "claims",
        vectorItemId: "hidden-tenant",
        embedding: vector({ 0: 1 }),
      },
      {
        tenantId: "t1",
        vectorSpaceVersionId: "v2",
        vectorSpaceKey: "claims",
        vectorItemId: "hidden-version",
        embedding: vector({ 0: 1 }),
      },
      {
        tenantId: "t1",
        vectorSpaceVersionId: "v1",
        vectorSpaceKey: "claims",
        vectorItemId: "withdrawn",
        embedding: vector({ 0: 1 }),
        lifecycle: "withdrawn",
      },
    ]);
    const result = await backend.search({
      tenantId: "t1",
      vectorSpaceVersionId: "v1",
      embedding: vector({ 0: 1 }),
      limit: 3,
    });
    expect(result.map(({ vectorItemId, score }) => [vectorItemId, score])).toEqual([
      ["a", 1],
      ["b", 1],
      ["c", 0],
    ]);
    expect(result[1]).toMatchObject({ searchProjectionId: "p2", searchText: "best" });
  });

  it("is append-only and rejects invalid query vectors", async () => {
    const item = {
      tenantId: "t1",
      vectorSpaceVersionId: "v1",
      vectorSpaceKey: "claims",
      vectorItemId: "one",
      embedding: vector({ 0: 1 }),
    };
    const backend = new InMemoryExactCosineBackend([item]);
    backend.add([item]);
    expect(() => backend.add([{ ...item, embedding: vector({ 1: 1 }) }])).toThrowError(/different content/);
    await expect(
      backend.search({ tenantId: "t1", vectorSpaceVersionId: "v1", embedding: vector({}), limit: 1 }),
    ).rejects.toThrowError(/zero query/);
    await expect(
      backend.search({ tenantId: "t1", vectorSpaceVersionId: "v1", embedding: Array(1_535).fill(0), limit: 1 }),
    ).rejects.toThrowError(/1535 dimensions/);
  });
});
