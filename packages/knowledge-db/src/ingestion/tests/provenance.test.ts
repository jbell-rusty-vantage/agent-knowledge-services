import { describe, expect, it } from "vitest";
import type { KnowledgeSqlClient } from "../../ports.js";
import { isOfficiallyAdmittedVerdict } from "../evidence-admission.js";
import { promoteOfficialClaimStatus } from "../provenance.js";

function recordingClient() {
  const statements: string[] = [];
  const client = {
    query: async (sql: string) => {
      statements.push(sql);
      return { rows: [], rowCount: 0 };
    },
  } as unknown as KnowledgeSqlClient;
  return { client, statements };
}

describe("canonical claim status promotion", () => {
  it.each(["directly_supported", "supported_with_qualification", "derived_verified", "literal_extraction_verified"])(
    "writes verified for sealed %s without rewriting the verdict",
    async (verdict) => {
      const claim = { verdict, qualifiers: ["in preview"] };
      const { client, statements } = recordingClient();
      expect(isOfficiallyAdmittedVerdict(claim.verdict)).toBe(true);
      expect(
        await promoteOfficialClaimStatus(client, {
          tenantId: "00000000-0000-4000-8000-000000000001",
          claimRowId: "00000000-0000-4000-8000-000000000002",
          verdict: claim.verdict,
        }),
      ).toBe(true);
      expect(claim.verdict).toBe(verdict);
      expect(claim.qualifiers).toEqual(["in preview"]);
      expect(statements).toEqual(["update evidence.claim set status='verified' where tenant_id=$1 and id=$2"]);
    },
  );
  it.each(["unsupported", "contradicted", "context_only", "held", "rejected", "retracted"])(
    "does not write verified for %s",
    async (verdict) => {
      const { client, statements } = recordingClient();
      expect(
        await promoteOfficialClaimStatus(client, {
          tenantId: "00000000-0000-4000-8000-000000000001",
          claimRowId: "00000000-0000-4000-8000-000000000002",
          verdict,
        }),
      ).toBe(false);
      expect(statements).toEqual([]);
    },
  );
});
