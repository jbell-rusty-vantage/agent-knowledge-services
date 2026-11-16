import { describe, expect, it } from "vitest";
import {
  AIDB_GUARD_SIGNATURE,
  AdmissionInstallationError,
  ExactUseAdmissionError,
  admitExactUseWithin,
  aidbGuardStatus,
} from "../exact-use-admission.js";
import type { KnowledgeSqlClient } from "../../ports.js";

/**
 * The AIDB native guard is `verification.assert_admitted_use` (AIDB 20261108120000 dropped the `research` schema). It
 * is the only form the admission path calls; an AI Engineer installation without it refuses AIDB_GUARD_REQUIRED.
 */
function fakeClient(installed: { guard: boolean; aiEngineer: boolean; guardError?: unknown }) {
  const calls: string[] = [];
  const client: KnowledgeSqlClient = {
    async query(text: string) {
      calls.push(text);
      if (text.includes("admit_exact_use")) {
        return {
          rows: [{ outcome: "admitted", reason: "ADMITTED", authoritative_epoch: "0" }] as never[],
          rowCount: 1,
        };
      }
      if (text.includes("to_regprocedure")) {
        return { rows: [{ guard: installed.guard, ai_engineer: installed.aiEngineer }] as never[], rowCount: 1 };
      }
      if (text.includes("assert_admitted_use")) {
        if (installed.guardError) throw installed.guardError;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return { client, calls };
}

const binding = {
  useDecisionId: "ud-1",
  boundEffectDigest: `sha256:${"a".repeat(64)}`,
  processedEpoch: 0,
  normalizedValuesDigest: `sha256:${"b".repeat(64)}`,
};

describe("AIDB guard", () => {
  it("names the verification. form and no other", () => {
    expect(AIDB_GUARD_SIGNATURE).toBe("verification.assert_admitted_use(uuid,text,text,bigint,text)");
  });

  it("calls verification.assert_admitted_use on an ai-engineer installation", async () => {
    const { client, calls } = fakeClient({ guard: true, aiEngineer: true });
    expect(await aidbGuardStatus(client)).toEqual({ aiEngineer: true, guard: true });
    const admitted = await admitExactUseWithin(client, "t", binding);
    expect(admitted.path).toBe("aidb_guard");
    expect(calls.filter((text) => text.includes("verification.assert_admitted_use("))).toHaveLength(1);
    expect(calls.some((text) => text.includes("research."))).toBe(false);
  });

  it("refuses AIDB_GUARD_REQUIRED on ai-engineer when the guard is not installed", async () => {
    const { client } = fakeClient({ guard: false, aiEngineer: true });
    await expect(admitExactUseWithin(client, "t", binding)).rejects.toBeInstanceOf(AdmissionInstallationError);
  });

  it("runs component_only outside ai-engineer", async () => {
    const { client, calls } = fakeClient({ guard: true, aiEngineer: false });
    expect((await admitExactUseWithin(client, "t", binding)).path).toBe("component_only");
    expect(calls.some((text) => text.includes("assert_admitted_use("))).toBe(false);
  });

  it("keeps the SQLSTATE mapping for the guard", async () => {
    const { client } = fakeClient({
      guard: true,
      aiEngineer: true,
      guardError: Object.assign(new Error("EFFECT_CONFLICT"), { code: "KSA03" }),
    });
    const error = await admitExactUseWithin(client, "t", binding).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ExactUseAdmissionError);
    expect((error as ExactUseAdmissionError).code).toBe("EFFECT_CONFLICT");
    expect((error as ExactUseAdmissionError).path).toBe("aidb_guard");
  });
});
