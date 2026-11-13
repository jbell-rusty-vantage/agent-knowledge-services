import { describe, expect, it } from "vitest";
import {
  AIDB_GUARD_SIGNATURES,
  AdmissionInstallationError,
  ExactUseAdmissionError,
  admitExactUseWithin,
  aidbGuardStatus,
} from "../exact-use-admission.js";
import type { KnowledgeSqlClient } from "../../ports.js";

/**
 * AIDB moved the native guard from `research.assert_admitted_use` to `verification.assert_admitted_use` (AIDB
 * 20261108120000). The admission path detects which 5-argument form is installed, prefers `verification.`, falls
 * back to `research.` only when that is the installed one, and refuses AIDB_GUARD_REQUIRED when neither exists.
 */
function fakeClient(installed: { current: boolean; legacy: boolean; aiEngineer: boolean; guardError?: unknown }) {
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
        return {
          rows: [
            { current: installed.current, legacy: installed.legacy, ai_engineer: installed.aiEngineer },
          ] as never[],
          rowCount: 1,
        };
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

describe("AIDB guard signature selection", () => {
  it("prefers verification.assert_admitted_use, then research., in that order", () => {
    expect(AIDB_GUARD_SIGNATURES).toEqual([
      "verification.assert_admitted_use(uuid,text,text,bigint,text)",
      "research.assert_admitted_use(uuid,text,text,bigint,text)",
    ]);
  });

  it("calls the verification. form when it is installed (even if research. also is)", async () => {
    const { client, calls } = fakeClient({ current: true, legacy: true, aiEngineer: true });
    expect(await aidbGuardStatus(client)).toEqual({
      aiEngineer: true,
      guard: true,
      signature: AIDB_GUARD_SIGNATURES[0],
    });
    const admitted = await admitExactUseWithin(client, "t", binding);
    expect(admitted.path).toBe("aidb_guard");
    expect(calls.filter((text) => text.includes("verification.assert_admitted_use("))).toHaveLength(1);
    expect(calls.some((text) => text.includes("research.assert_admitted_use("))).toBe(false);
  });

  it("falls back to the research. form only when it is the installed one (vendored contract 0.6.0)", async () => {
    const { client, calls } = fakeClient({ current: false, legacy: true, aiEngineer: true });
    const admitted = await admitExactUseWithin(client, "t", binding);
    expect(admitted.path).toBe("aidb_guard");
    expect(calls.filter((text) => text.includes("research.assert_admitted_use("))).toHaveLength(1);
    expect(calls.some((text) => text.includes("verification.assert_admitted_use("))).toBe(false);
  });

  it("refuses AIDB_GUARD_REQUIRED on ai-engineer when neither form is installed", async () => {
    const { client } = fakeClient({ current: false, legacy: false, aiEngineer: true });
    await expect(admitExactUseWithin(client, "t", binding)).rejects.toBeInstanceOf(AdmissionInstallationError);
  });

  it("runs component_only outside ai-engineer", async () => {
    const { client, calls } = fakeClient({ current: true, legacy: false, aiEngineer: false });
    expect((await admitExactUseWithin(client, "t", binding)).path).toBe("component_only");
    expect(calls.some((text) => text.includes("assert_admitted_use("))).toBe(false);
  });

  it("keeps the SQLSTATE mapping for the verification. guard", async () => {
    const { client } = fakeClient({
      current: true,
      legacy: false,
      aiEngineer: true,
      guardError: Object.assign(new Error("EFFECT_CONFLICT"), { code: "KSA03" }),
    });
    const error = await admitExactUseWithin(client, "t", binding).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ExactUseAdmissionError);
    expect((error as ExactUseAdmissionError).code).toBe("EFFECT_CONFLICT");
    expect((error as ExactUseAdmissionError).path).toBe("aidb_guard");
  });
});
