import { describe, expect, it } from "vitest";
import type { SourceLocator } from "@aiengineer/knowledge-contracts";
import { sha256Digest } from "@aiengineer/knowledge-core";
import { createProjection } from "../projection/index.js";
import type { ProjectionInput } from "../types.js";
import { validateEvidenceSupport } from "./evidence-support.js";

const id = (digit: number) => `00000000-0000-4000-8000-${String(digit).padStart(12, "0")}`;
const quotedText = "The source supports this assertion.";
const locator: SourceLocator = {
  representationId: id(10),
  nodeId: id(11),
  startOffset: 0,
  endOffset: quotedText.length,
  quoteDigest: sha256Digest(quotedText),
};
const common = {
  sourceRecordId: id(1),
  procedureVersionId: id(2),
  evidence: [{ locatorId: id(3), locator, quotedText }],
  assertions: [{ id: "a1", statement: "Supported assertion", supportLocatorIds: [id(3)] }],
};
const engineeringClaim: ProjectionInput = {
  ...common,
  space: "engineering_claims",
  claimClass: "verified_fact",
  attribution: "source",
  problem: "retrieval",
  mechanism: "stable evidence",
  applicability: ["systems"],
  limitations: ["version scoped"],
};
const sourceNative: ProjectionInput = {
  sourceRecordId: id(1),
  procedureVersionId: id(2),
  evidence: common.evidence,
  assertions: [],
  space: "source_native_sections",
  sectionPath: ["Results"],
  sourceText: quotedText,
};

describe("validateEvidenceSupport", () => {
  it("rejects unsupported assertions and altered quoted evidence", () => {
    const unsupported: ProjectionInput = {
      ...engineeringClaim,
      assertions: [{ id: "bad", statement: "No source", supportLocatorIds: [id(99)] }],
    };
    expect(validateEvidenceSupport(unsupported).issues).toContain(`bad: unknown support locator ${id(99)}`);
    expect(() => createProjection(unsupported)).toThrow(/evidence validation failed/);
    const altered: ProjectionInput = {
      ...engineeringClaim,
      evidence: [{ ...common.evidence[0]!, quotedText: "altered" }],
    };
    expect(validateEvidenceSupport(altered).issues).toContain(`${id(3)}: quote digest mismatch`);
    const unfaithful: ProjectionInput = { ...sourceNative, sourceText: "rewritten" };
    expect(validateEvidenceSupport(unfaithful).issues).toContain(
      "source-native text does not exactly match ordered evidence text",
    );
  });

  it("reports duplicate evidence locator ids", () => {
    const duplicated: ProjectionInput = {
      ...engineeringClaim,
      evidence: [...common.evidence, { ...common.evidence[0]! }],
    };
    expect(validateEvidenceSupport(duplicated).issues).toContain(`duplicate evidence locator ${id(3)}`);
  });

  it("reports an empty quoted text", () => {
    const empty: ProjectionInput = {
      ...engineeringClaim,
      evidence: [{ locatorId: id(4), locator, quotedText: "   " }],
    };
    expect(validateEvidenceSupport(empty).issues).toContain(`${id(4)}: quoted text is empty`);
  });

  it("requires supported assertions for a derived space with zero assertions", () => {
    const noAssertions: ProjectionInput = { ...engineeringClaim, assertions: [] };
    expect(validateEvidenceSupport(noAssertions).issues).toContain("derived projections require supported assertions");
  });
});
