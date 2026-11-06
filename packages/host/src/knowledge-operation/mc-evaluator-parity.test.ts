import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type JsonValue, digestBytes, digestCanonical } from "@aiengineer/knowledge-operation-protocol";
import { VerificationObservationSchema } from "@aiengineer/knowledge-research-core";
import { describe, expect, it } from "vitest";
import { SubmittedCensusSchema } from "./assessment.js";
import { recordCollision } from "./service.js";

/**
 * OVE-169 W1 D20: the Mission Control auditor's census and judge's observations, produced by MC's evaluator from KS-built
 * evaluation contexts (MC `tests/unit/knowledge/test_evaluator_parity.py`, contexts from MC
 * `scripts/ks_evaluation_parity.mjs`), are documents KS accepts. The live W1 auditor census was refused on every pass
 * ("the census is not a valid discovery": its spans lacked research-core's `basis`). The fixture is a copy of MC's
 * `tests/fixtures/knowledge_protocol/mc-evaluator-parity.json`, pinned by canonical digest on both sides.
 */
const PARITY_DIGEST = "sha256:ba0decdbf49dc6a8ca98f5e308b7aaa381fac987dfb86b1cf78738f1059740a7";
const parity = JSON.parse(
  readFileSync(fileURLToPath(new URL("../tests/fixtures/mc-evaluator-parity.json", import.meta.url)), "utf8"),
) as { census: Record<string, unknown>; observations: Record<string, unknown>[] };

describe("Mission Control evaluator documents (W1 D20 parity)", () => {
  it("is the exact MC output", () => {
    expect(digestCanonical(parity as unknown as JsonValue)).toBe(PARITY_DIGEST);
  });

  it("the auditor census is a valid discovery", () => {
    const parsed = SubmittedCensusSchema.safeParse(parity.census);
    expect(
      parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    ).toEqual([]);
    for (const occurrence of parsed.data?.occurrences ?? []) {
      expect(occurrence.span.basis).toBe("utf16-code-units-v1");
      expect(occurrence.quoteDigest).toBe(digestBytes(occurrence.candidateAssertion));
    }
  });

  it("a census without span bases is refused, as the live W1 census was", () => {
    const occurrences = (parity.census.occurrences as Record<string, unknown>[]).map((occurrence) => {
      const { basis: _basis, ...span } = occurrence.span as Record<string, unknown>;
      return { ...occurrence, span };
    });
    const parsed = SubmittedCensusSchema.safeParse({ ...parity.census, occurrences });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.some((issue) => issue.path.join(".") === "occurrences.0.span.basis")).toBe(true);
  });

  it("every judge observation is a valid research-core observation", () => {
    expect(parity.observations.length).toBeGreaterThan(0);
    for (const observation of parity.observations) {
      const parsed = VerificationObservationSchema.safeParse(observation);
      expect(
        parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      ).toEqual([]);
    }
  });
});

describe("registration record collisions (W1 D19)", () => {
  it("names the record and id of both binding wordings", () => {
    expect(recordCollision("ASSERTION_CONFLICT: asr-1 holds another record")).toEqual({
      reason: "record_id_conflict",
      record: "assertion",
      id: "asr-1",
    });
    expect(recordCollision("SUPPORT_SET_DIGEST_EXISTS: this record is stored as ss-7")).toEqual({
      reason: "record_digest_exists",
      record: "support_set",
      id: "ss-7",
    });
    expect(recordCollision("TASK_NOT_FOUND")).toBeNull();
    // The PostgreSQL binding's typed ComponentError: its code decides, its message ("CODE: detail") names the id.
    expect(recordCollision("FRAGMENT_CONFLICT: frag-1 holds another record", "FRAGMENT_CONFLICT")?.id).toBe("frag-1");
    expect(recordCollision("ASSERTION_CONFLICT: asr-1 holds another record", "RUN_SEALED")).toBeNull();
  });
});
