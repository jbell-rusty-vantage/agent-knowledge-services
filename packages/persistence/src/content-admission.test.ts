import { describe, expect, it } from "vitest";
import { postgresContentAdmission } from "./content-admission.js";
import { readContentRepresentationAdmission } from "./content-representation-admission.js";
import { persistPreparedContentSummary } from "./content-summary-preparation.js";
import type { TenantSqlClient } from "./postgres.js";

describe("knowledge-db content-admission adapter", () => {
  it("delegates to the canonical admission read and summary write without wrapping them", () => {
    expect(postgresContentAdmission.readRepresentationAdmission).toBe(readContentRepresentationAdmission);
    expect(postgresContentAdmission.persistPreparedSummary).toBe(persistPreparedContentSummary);
    expect(Object.isFrozen(postgresContentAdmission)).toBe(true);
  });

  it("runs in the caller's transaction client", async () => {
    const statements: unknown[][] = [];
    const client = {
      async query(sql: string, values: unknown[]) {
        statements.push([sql, values]);
        return { rows: [], rowCount: 0 };
      },
    } as unknown as TenantSqlClient;
    await expect(
      postgresContentAdmission.readRepresentationAdmission(client, {
        tenantId: "tenant",
        representationId: "representation",
        guardedDigest: `sha256:${"a".repeat(64)}`,
      }),
    ).resolves.toEqual({ accepted: false, decisionId: null, decision: null });
    expect(statements).toHaveLength(1);
    expect(statements[0]![1]).toEqual(["tenant", "representation"]);
  });
});
