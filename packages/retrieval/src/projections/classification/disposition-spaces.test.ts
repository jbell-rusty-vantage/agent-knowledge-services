import { describe, expect, it } from "vitest";
import type { ClassificationProposal, DomainDisposition } from "../types.js";
import { classifyProjectionSpaces, publicProjectionSpaces } from "./disposition-spaces.js";

const id = (digit: number) => `00000000-0000-4000-8000-${String(digit).padStart(12, "0")}`;
const base: ClassificationProposal = {
  dispositions: ["engineering_claim"],
  targetContractVersion: "v1",
  deduplicationKeys: ["claim:x"],
  evidenceLocatorIds: [id(3)],
  unresolvedIdentityQuestions: [],
};

describe("classifyProjectionSpaces", () => {
  it("validates classification evidence and resolved canonical identities", () => {
    expect(
      classifyProjectionSpaces({
        dispositions: ["engineering_claim", "faithful_source_section"],
        targetContractVersion: "v1",
        deduplicationKeys: ["claim:x"],
        evidenceLocatorIds: [id(3)],
        unresolvedIdentityQuestions: [],
      }),
    ).toEqual(["engineering_claims", "source_native_sections"]);
    expect(() =>
      classifyProjectionSpaces({
        dispositions: ["entity_profile"],
        targetContractVersion: "v1",
        deduplicationKeys: ["entity:x"],
        evidenceLocatorIds: [id(3)],
        unresolvedIdentityQuestions: ["which Tool?"],
      }),
    ).toThrow(/resolved entity/);
  });

  it("rejects an empty targetContractVersion", () => {
    expect(() => classifyProjectionSpaces({ ...base, targetContractVersion: "  " })).toThrow(/target contract version/);
  });

  it("rejects an unknown disposition", () => {
    const invalid: ClassificationProposal = { ...base, dispositions: ["not_a_real_disposition" as DomainDisposition] };
    expect(() => classifyProjectionSpaces(invalid)).toThrow(/Unknown domain disposition/);
  });

  it("rejects not_ingestible combined with another disposition", () => {
    expect(() => classifyProjectionSpaces({ ...base, dispositions: ["not_ingestible", "engineering_claim"] })).toThrow(
      /not_ingestible cannot be combined/,
    );
  });

  it("rejects a proposal missing evidence locators", () => {
    expect(() => classifyProjectionSpaces({ ...base, evidenceLocatorIds: [] })).toThrow(/requires evidence/);
  });

  it("rejects a proposal missing deduplication keys", () => {
    expect(() => classifyProjectionSpaces({ ...base, deduplicationKeys: [] })).toThrow(/requires deduplication keys/);
  });
});

describe("publicProjectionSpaces", () => {
  it("has exactly the seven public domains and excludes source_native_sections", () => {
    expect(publicProjectionSpaces).toHaveLength(7);
    expect(publicProjectionSpaces).not.toContain("source_native_sections");
    expect([...publicProjectionSpaces].sort()).toEqual([
      "benchmark_intelligence",
      "engineering_claims",
      "entity_profiles",
      "implementation_examples",
      "model_capabilities",
      "paper_case_study_knowledge",
      "tool_capabilities",
    ]);
  });
});
