import { describe, expect, it } from "vitest";
import { VerificationBenchmarkV1CandidatePoolSchema } from "./benchmark.js";

const digest = (value: number) => `sha256:${value.toString(16).padStart(64, "0")}`;
const uuid = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
const pool = () => ({
  schemaVersion: "verification-benchmark-v1-candidate-pool.v1",
  status: "unlabeled_unfrozen_candidates",
  sourcePreparationDigest: digest(900),
  count: 150,
  independentObservationCount: 0,
  limitation: "Human annotation and sealing are pending.",
  candidates: Array.from({ length: 150 }, (_, index) => ({
    candidateId: `candidate-${index}`,
    fragmentId: digest(index + 1),
    sourceKey: `source-${index % 5}`,
    sourceClass: index % 2 ? "publication" : "first_party",
    captureId: uuid(index + 1),
    projectionArtifactId: uuid(index + 201),
    projectionDigest: digest(index + 301),
    selector: { kind: "html", domPath: `1/${index}` },
    selectedContentDigest: digest(index + 501),
    labelStatus: "annotation_pending",
    independentObservation: false,
  })),
});

describe("VerificationBenchmarkV1CandidatePool", () => {
  it("admits a 150-row multi-source unlabeled source-bound pool", () => {
    expect(VerificationBenchmarkV1CandidatePoolSchema.parse(pool()).count).toBe(150);
  });

  it("rejects duplicate fragments, inflated counts, labels, independence, and unknown fields", () => {
    const duplicate = pool();
    duplicate.candidates[1] = { ...duplicate.candidates[1]!, fragmentId: duplicate.candidates[0]!.fragmentId };
    expect(VerificationBenchmarkV1CandidatePoolSchema.safeParse(duplicate).success).toBe(false);
    expect(VerificationBenchmarkV1CandidatePoolSchema.safeParse({ ...pool(), count: 151 }).success).toBe(false);
    expect(
      VerificationBenchmarkV1CandidatePoolSchema.safeParse({
        ...pool(),
        candidates: pool().candidates.map((item, index) =>
          index ? item : { ...item, labelStatus: "expert_adjudicated" },
        ),
      }).success,
    ).toBe(false);
    expect(
      VerificationBenchmarkV1CandidatePoolSchema.safeParse({
        ...pool(),
        candidates: pool().candidates.map((item, index) => (index ? item : { ...item, independentObservation: true })),
      }).success,
    ).toBe(false);
    expect(VerificationBenchmarkV1CandidatePoolSchema.safeParse({ ...pool(), futureField: true }).success).toBe(false);
  });
});
