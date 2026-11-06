import { retrieve } from "../../src/index.js";
import { policy, printJson, records, tenantId } from "./fixtures.js";

const otherTenant = "00000000-0000-7000-8000-999999999999";

/**
 * Abstention is a reasoned recommendation, not silence: a query no record can
 * satisfy is flagged with why. Separately, every omission — cross-tenant,
 * unpromoted, restricted visibility, retracted — is recorded by reason rather
 * than dropped, even when the record would otherwise have scored well.
 */
export async function abstainAndOmitExample() {
  const abstained = await retrieve("nonexistent required topic", {
    tenantId,
    policy,
    records,
  });

  const mixedRecords = [
    { ...records[0]!, id: "r0-tenant-mismatch", tenantId: otherTenant },
    { ...records[1]!, id: "r1-unpromoted", promoted: false },
    {
      ...records[0]!,
      id: "r0-private",
      fields: { ...records[0]!.fields, visibility: "private" },
    },
    {
      ...records[0]!,
      id: "r0-retracted",
      flags: {
        retracted: true,
        corrected: false,
        contradicted: false,
        deprecated: false,
        superseded: false,
      },
    },
  ];
  const withOmissions = await retrieve("agent-loop", {
    tenantId,
    policy,
    records: mixedRecords,
  });

  return {
    coverageAbstention: {
      recommended: abstained.abstention.recommended,
      reason: abstained.abstention.reason,
    },
    omittedReasons: withOmissions.omittedResults.map((o) => o.reason),
  };
}

if (process.argv[1]?.includes("03-abstain-and-omit")) printJson(await abstainAndOmitExample());
