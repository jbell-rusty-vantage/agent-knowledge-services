import { describe, expect, it } from "vitest";
import { PostgresGovernedIndexRepository } from "./governance.js";
import type { PostgresCanonicalRepository, TenantSqlClient } from "./postgres.js";
import type { GovernedProjectionProposalInput, PersistGovernedEmbeddingRunInput } from "./types.js";

describe("governed selection fail-closed boundaries", () => {
  it.each([false, undefined])(
    "rejects a promotion whose current independent review is not proven (%s)",
    async (reviewBound) => {
      const queries: string[] = [];
      const client: TenantSqlClient = {
        async query(sql) {
          queries.push(sql);
          if (sql.includes("from retrieval.vector_space_version"))
            return { rows: [{ dims: 1536, precision: "halfvec" }] as never[], rowCount: 1 };
          if (sql.includes("from retrieval.content_promotion_decision"))
            return { rows: [{ id: "decision", review_bound: reviewBound }] as never[], rowCount: 1 };
          throw new Error("unexpected query after invalid review");
        },
      };
      const database = {
        transaction: async (_tenantId: string, callback: (client: TenantSqlClient) => Promise<unknown>) =>
          callback(client),
      } as PostgresCanonicalRepository;
      await expect(
        new PostgresGovernedIndexRepository(database).loadEmbeddingContext("tenant", "version", "decision", [
          "projection",
        ]),
      ).rejects.toThrow("EMBEDDING_PROMOTION_NOT_APPROVED");
      expect(queries).toHaveLength(2);
    },
  );
  function fixture() {
    const queries: string[] = [];
    const client: TenantSqlClient = {
      async query(sql) {
        queries.push(sql);
        return { rows: [], rowCount: 0 };
      },
    };
    const database = {
      transaction: async (_tenantId: string, callback: (client: TenantSqlClient) => Promise<unknown>) =>
        callback(client),
    } as PostgresCanonicalRepository;
    return { repository: new PostgresGovernedIndexRepository(database), queries };
  }
  it("rejects legacy whole-chunk-set proposals before any canonical read or write", async () => {
    const f = fixture();
    await expect(
      f.repository.persistProjectionProposal("tenant", { chunkSetId: "all-chunks" } as GovernedProjectionProposalInput),
    ).rejects.toThrow("PROMOTION_SELECTION_REQUIRED");
    expect(f.queries).toEqual([]);
  });
  it("does not settle a caller-created embedding context without selection authority", async () => {
    const f = fixture();
    await expect(
      f.repository.persistEmbeddingRun("tenant", {
        context: { selectionDigest: "forged", selectionBudget: {} },
      } as PersistGovernedEmbeddingRunInput),
    ).rejects.toThrow("PROMOTION_SELECTION_REQUIRED");
    expect(f.queries).toEqual([]);
  });
});
