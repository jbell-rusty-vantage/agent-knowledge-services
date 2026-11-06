import { describe, expect, it } from "vitest";
import type { TenantSqlClient } from "./postgres.js";
import { sha256Digest } from "@aiengineer/knowledge-core";
import {
  applyPublishedQueryPlanner,
  assertPublicationDependenciesEligible,
  explainedPlanText,
  publishedRecallAtK,
  queryPublishedSpace,
  rankedItems,
  verifyPublicationBaseline,
} from "./publication-evaluation.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const queryEmbedding = Object.freeze(Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0)));
const EXACT_PLAN = Object.freeze([
  "Seq Scan on vector_item_embedding_1536 x",
  "  Filter: ((tenant_id = $1) AND (vector_space_version_id = $3))",
  "  Sort Key: ((embedding <=> $2::halfvec))",
]);
const ANN_PLAN = Object.freeze([
  "Index Scan using vector_item_embedding_1536_hnsw_idx on vector_item_embedding_1536 x",
  "  Order By: (embedding <=> $2::extensions.halfvec)",
  "  Filter: ((tenant_id = $1) AND (vector_space_version_id = $3))",
]);
const SEQ_ONLY_PLAN = Object.freeze([
  "Seq Scan on vector_item_embedding_1536 x",
  "  Filter: ((tenant_id = $1) AND (vector_space_version_id = $3))",
]);
const BTREE_INDEX_PLAN = Object.freeze([
  "Index Scan using vector_item_embedding_1536_pkey on vector_item_embedding_1536 x",
  "  Index Cond: (tenant_id = $1)",
  "  Filter: (vector_space_version_id = $3)",
]);

describe("frozen vector identity binding", () => {
  it.each(["swap", "missing"])("rejects %s bindings before dependency eligibility", async (mode) => {
    const rows = [0, 1].map((index) => ({
      vector_item_id: id(index + 10),
      search_projection_id: id(index + 20),
      embedding_run_id: id(30),
      embedding_status: "succeeded",
      lifecycle: "active",
      verification_state: "verified",
      vector_space_key: "engineering_claims",
      dimensions: 1536,
      finite: true,
      physical_digest_verified: true,
      input_sha256: "text",
      embedding_text_sha256: "text",
      index_ready: true,
      ordinal: index,
      physical_embedding_sha256: index === 0 ? "digest-b" : "digest-a",
    }));
    const observations = {
      vectorSpaceVersionId: id(3),
      projectionIds: [id(20), id(21)],
      embeddingRunId: id(30),
      space: "engineering_claims",
      vectorIds: [id(10), id(11)],
      physicalDigests: ["digest-a", "digest-b"],
      ...(mode === "swap"
        ? {
            vectorBindings: [
              { vectorItemId: id(10), physicalDigest: "digest-a" },
              { vectorItemId: id(11), physicalDigest: "digest-b" },
            ],
          }
        : {}),
    };
    const client: TenantSqlClient = {
      async query<R extends Record<string, unknown>>(sql: string) {
        const result = sql.includes("from retrieval.space_publication")
          ? [{ vector_space_version_id: id(3), evaluation_result_id: id(4) }]
          : sql.includes("from evaluation.promotion_gate_result")
            ? [
                {
                  observations,
                  passed: true,
                  gate_slug: "selected-candidate-activation",
                  result_sha256: sha256Digest(observations).slice(7),
                },
              ]
            : sql.includes("from retrieval.vector_item v")
              ? rows
              : (() => {
                  throw new Error("Unexpected eligibility query");
                })();
        return { rows: result as unknown as R[], rowCount: result.length };
      },
    };
    await expect(assertPublicationDependenciesEligible(client, id(1), id(2))).rejects.toThrow(
      "PUBLICATION_EVALUATED_VECTOR_DRIFT",
    );
  });
});

describe("frozen rollback query coverage", () => {
  it.each(["empty", "subset", "duplicate", "changed_embedding"])(
    "rejects %s query evidence before ranking",
    async (mode) => {
      const observations = {
        answers: ["first", "second"].map((queryId) => ({
          queryId,
          embeddingDigest: sha256Digest([...queryEmbedding]),
          exact: [],
          ann: [],
        })),
      };
      const statements: string[] = [];
      const client: TenantSqlClient = {
        async query<R extends Record<string, unknown>>(sql: string) {
          statements.push(sql);
          const rows = sql.includes("from evaluation.promotion_gate_result")
            ? [
                {
                  observations,
                  passed: true,
                  gate_slug: "selected-candidate-activation",
                  result_sha256: sha256Digest(observations).slice(7),
                },
              ]
            : [{ id: id(3), evaluation_result_id: id(4), vector_space_version_id: id(5) }];
          return { rows: rows as unknown as R[], rowCount: rows.length };
        },
      };
      const queries =
        mode === "empty"
          ? []
          : mode === "subset"
            ? [{ queryId: "first", embedding: queryEmbedding }]
            : mode === "duplicate"
              ? ["first", "first"].map((queryId) => ({ queryId, embedding: queryEmbedding }))
              : [
                  { queryId: "first", embedding: queryEmbedding },
                  { queryId: "second", embedding: Array.from({ length: 1536 }, () => 1) },
                ];
      await expect(
        verifyPublicationBaseline(client, { tenantId: id(1), vectorStoreSpaceId: id(2), queries }),
      ).rejects.toThrow("PUBLICATION_BASELINE_QUERY_MISMATCH");
      expect(statements.some((sql) => sql.includes("vector_item_embedding"))).toBe(false);
    },
  );
});

function item(n: number, score: number) {
  return { vectorItemId: id(n), searchProjectionId: id(100 + n), score };
}

function plannerStatements(sql: readonly string[]): string[] {
  return sql.filter((statement) => /^(set|reset) local/i.test(statement.trim()));
}

function firstIndex(sql: readonly string[], fragment: string): number {
  return sql.findIndex((statement) => statement.includes(fragment));
}

function recordingClient(input: {
  exactItems?: readonly ReturnType<typeof item>[];
  annItems?: readonly ReturnType<typeof item>[];
  exactPlan?: readonly string[];
  annPlan?: readonly string[];
  pointer?: boolean;
}): { client: TenantSqlClient; sql: string[] } {
  const sql: string[] = [];
  let mode: "exact" | "ann" | undefined;
  const client: TenantSqlClient = {
    async query<R extends Record<string, unknown>>(text: string) {
      sql.push(text);
      const result = (rows: readonly Record<string, unknown>[]) => ({
        rows: rows as unknown as R[],
        rowCount: rows.length,
      });
      if (/^(set|reset) local/i.test(text.trim())) {
        if (text.includes("enable_indexscan=off")) mode = "exact";
        if (text.includes("enable_seqscan=off")) mode = "ann";
        return result([]);
      }
      if (text.trim().toLowerCase().startsWith("explain")) {
        const lines = mode === "ann" ? (input.annPlan ?? ANN_PLAN) : (input.exactPlan ?? EXACT_PLAN);
        return result(lines.map((line) => ({ "QUERY PLAN": line })));
      }
      if (text.includes("from retrieval.vector_store_space")) {
        return result(
          input.pointer === false
            ? []
            : [
                {
                  active_space_version_id: id(2),
                  publication_id: id(3),
                  status: "published",
                  expected_item_count: 4,
                  slug: "engineering_claims",
                },
              ],
        );
      }
      if (text.includes("from retrieval.vector_item_embedding_1536")) {
        const items =
          mode === "ann"
            ? (input.annItems ?? [item(1, 0.9)])
            : (input.exactItems ?? [item(1, 0.9), item(2, 0.8), item(3, 0.7), item(4, 0.6)]);
        return result(
          items.map((row) => ({
            vector_item_id: row.vectorItemId,
            search_projection_id: row.searchProjectionId,
            score: row.score,
          })),
        );
      }
      return result([]);
    },
  };
  return { client, sql };
}

function rankedInput(mode: "exact" | "ann") {
  return {
    tenantId: id(1),
    versionId: id(2),
    embedding: queryEmbedding,
    resultLimit: 4,
    mode,
    vectorSpaceKey: "engineering_claims",
  };
}

describe("published query planner isolation", () => {
  it("restores index and bitmap scans for ANN after exact on the same client, before seqscan/hnsw", async () => {
    const { client, sql } = recordingClient({});
    await rankedItems(client, rankedInput("exact"));
    const afterExact = plannerStatements(sql).length;
    await rankedItems(client, rankedInput("ann"));
    const exactPlanner = plannerStatements(sql.slice(0, afterExact));
    const annPlanner = plannerStatements(sql.slice(afterExact));

    expect(exactPlanner.some((statement) => statement.includes("enable_indexscan=off"))).toBe(true);
    expect(exactPlanner.some((statement) => statement.includes("enable_bitmapscan=off"))).toBe(true);
    expect(exactPlanner.some((statement) => statement.includes("enable_seqscan=off"))).toBe(false);

    const restoreIndex = firstIndex(annPlanner, "enable_indexscan=on");
    const restoreBitmap = firstIndex(annPlanner, "enable_bitmapscan=on");
    const disableSeq = firstIndex(annPlanner, "enable_seqscan=off");
    const efSearch = firstIndex(annPlanner, "hnsw.ef_search=200");
    expect(restoreIndex).toBeGreaterThanOrEqual(0);
    expect(restoreBitmap).toBeGreaterThanOrEqual(0);
    expect(disableSeq).toBeGreaterThan(restoreIndex);
    expect(disableSeq).toBeGreaterThan(restoreBitmap);
    expect(efSearch).toBeGreaterThan(restoreIndex);
    expect(efSearch).toBeGreaterThan(restoreBitmap);
  });

  it("applies complementary SET LOCAL restore before each arm's own constraints", async () => {
    const { client, sql } = recordingClient({});
    await applyPublishedQueryPlanner(client, "exact");
    await applyPublishedQueryPlanner(client, "ann");
    expect(sql).toEqual([
      "set local enable_seqscan=on",
      "set local hnsw.ef_search to default",
      "set local enable_indexscan=off",
      "set local enable_bitmapscan=off",
      "set local enable_indexscan=on",
      "set local enable_bitmapscan=on",
      "set local enable_seqscan=off",
      "set local hnsw.ef_search=200",
    ]);
  });
});

describe("published query plan capture", () => {
  it("retains every EXPLAIN line, not the first line only", async () => {
    expect(explainedPlanText(ANN_PLAN.map((line) => ({ "QUERY PLAN": line })))).toBe(ANN_PLAN.join("\n"));
    const { client } = recordingClient({});
    const exact = await rankedItems(client, rankedInput("exact"));
    const ann = await rankedItems(client, rankedInput("ann"));
    expect(exact.plan).toBe(EXACT_PLAN.join("\n"));
    expect(ann.plan).toBe(ANN_PLAN.join("\n"));
    expect(ann.plan.split("\n")).toHaveLength(ANN_PLAN.length);
    expect(ann.plan).toMatch(/Index Scan/i);
    expect(ann.plan).toMatch(/hnsw/i);
  });

  it("stores the ANN plan text on queryPublishedSpace.annPlan", async () => {
    const { client } = recordingClient({ pointer: true });
    const exact = await queryPublishedSpace(client, {
      tenantId: id(1),
      vectorStoreSpaceId: id(9),
      embedding: queryEmbedding,
      resultLimit: 4,
      mode: "exact",
    });
    const ann = await queryPublishedSpace(client, {
      tenantId: id(1),
      vectorStoreSpaceId: id(9),
      embedding: queryEmbedding,
      resultLimit: 4,
      mode: "ann",
    });
    expect(exact.annPlan).toBe(EXACT_PLAN.join("\n"));
    expect(ann.annPlan).toBe(ANN_PLAN.join("\n"));
    expect(ann.historical.map((row) => row.vectorItemId)).toEqual([id(1)]);
  });

  it("rejects an ANN arm whose captured plan is sequential-scan only", async () => {
    const { client } = recordingClient({ annPlan: SEQ_ONLY_PLAN });
    await expect(rankedItems(client, rankedInput("ann"))).rejects.toThrow("PUBLICATION_ANN_PLAN_NOT_HNSW");
  });

  it("rejects an ANN arm whose captured plan is a non-HNSW index scan", async () => {
    const { client } = recordingClient({ annPlan: BTREE_INDEX_PLAN });
    await expect(rankedItems(client, rankedInput("ann"))).rejects.toThrow("PUBLICATION_ANN_PLAN_NOT_HNSW");
  });
});

describe("ANN access proof", () => {
  it.each([
    ["Bitmap Index Scan on misleading_hnsw_idx"],
    [...BTREE_INDEX_PLAN, "  Filter: (label = 'hnsw')"],
    ["Seq Scan on hnsw_table", "  -> Index Scan using unrelated_pkey on other_table"],
  ])("rejects HNSW mentions without an HNSW index scan", async (...annPlan) => {
    const { client } = recordingClient({ annPlan });
    await expect(rankedItems(client, rankedInput("ann"))).rejects.toThrow("PUBLICATION_ANN_PLAN_NOT_HNSW");
  });
});

describe("published recall and query vector guards", () => {
  it("does not treat a one-item overlap as success against a four-item exact set at recall 1.0", async () => {
    const { client } = recordingClient({
      exactItems: [item(1, 0.99), item(2, 0.9), item(3, 0.8), item(4, 0.7)],
      annItems: [item(1, 0.99)],
    });
    const exact = await rankedItems(client, rankedInput("exact"));
    const ann = await rankedItems(client, rankedInput("ann"));
    expect(exact.items).toHaveLength(4);
    const recall = publishedRecallAtK(exact.items, ann.items);
    expect(recall).toBe(0.25);
    expect(recall).toBeLessThan(1);
  });

  it.each([
    ["wrong dimension", Object.freeze(Array.from({ length: 8 }, () => 0)), "PUBLICATION_QUERY_DIMENSIONS_INVALID"],
    [
      "non-finite",
      Object.freeze(Array.from({ length: 1536 }, (_, index) => (index === 0 ? Number.NaN : 0))),
      "PUBLICATION_QUERY_VECTOR_INVALID",
    ],
    [
      "infinite",
      Object.freeze(Array.from({ length: 1536 }, (_, index) => (index === 0 ? Number.POSITIVE_INFINITY : 0))),
      "PUBLICATION_QUERY_VECTOR_INVALID",
    ],
  ] as const)("rejects a %s query embedding", async (_label, embedding, code) => {
    const { client, sql } = recordingClient({});
    await expect(rankedItems(client, { ...rankedInput("ann"), embedding })).rejects.toThrow(code);
    expect(sql).toEqual([]);
  });

  it("rejects an unknown vector space before ranking", async () => {
    const { client, sql } = recordingClient({});
    await expect(rankedItems(client, { ...rankedInput("ann"), vectorSpaceKey: "not_a_space" })).rejects.toThrow(
      "PUBLICATION_VECTOR_SPACE_UNKNOWN",
    );
    expect(sql).toEqual([]);
  });

  it("ranks the physical space partition so ANN can use HNSW", async () => {
    const { client, sql } = recordingClient({});
    await rankedItems(client, rankedInput("ann"));
    expect(sql.some((statement) => statement.includes("vector_item_embedding_1536_engineering_claims"))).toBe(true);
    expect(sql.some((statement) => /from retrieval\.vector_item_embedding_1536\s/.test(statement))).toBe(false);
  });
});
