import { describe, expect, it } from "vitest";
import type { SourceLocator } from "@aiengineer/knowledge-contracts";
import { sha256Digest } from "@aiengineer/knowledge-core";
import { publicProjectionSpaces } from "../classification/index.js";
import type { ProjectionInput } from "../types.js";
import { createProjection } from "./create-projection.js";

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

const inputs: readonly ProjectionInput[] = [
  {
    ...common,
    space: "engineering_claims",
    claimClass: "verified_fact",
    attribution: "source",
    problem: "retrieval",
    mechanism: "stable evidence",
    applicability: ["systems"],
    limitations: ["version scoped"],
  },
  { ...common, space: "tool_capabilities", toolName: "Tool", capabilities: ["search"], constraints: ["versioned"] },
  {
    ...common,
    space: "implementation_examples",
    objective: "Implement retrieval",
    language: "TypeScript",
    commit: "abc",
    path: "src/index.ts",
  },
  {
    ...common,
    space: "paper_case_study_knowledge",
    title: "Study",
    findingClass: "result",
    derived: true,
    sectionRole: "result",
    findings: ["Improved recall"],
    caveats: ["Small sample"],
  },
  {
    ...common,
    space: "entity_profiles",
    entityType: "tool",
    canonicalName: "Tool",
    aliases: ["T"],
    profileKind: "identity",
  },
  {
    ...common,
    space: "model_capabilities",
    modelVersion: "model-v1",
    capabilities: ["reasoning"],
    constraints: ["text only"],
    observedAt: "2026-09-03T12:00:00Z",
  },
  {
    ...common,
    space: "benchmark_intelligence",
    benchmarkVersion: "bench-v1",
    metric: "accuracy",
    protocol: "zero-shot",
    comparabilityWarnings: [],
    measuredTask: "reasoning",
  },
  {
    sourceRecordId: id(1),
    procedureVersionId: id(2),
    evidence: common.evidence,
    assertions: [],
    space: "source_native_sections",
    sectionPath: ["Results"],
    sourceText: quotedText,
  },
];

describe("createProjection", () => {
  it("builds deterministic contract-valid projections for every space", () => {
    expect(inputs.map((input) => createProjection(input).space)).toEqual([
      ...publicProjectionSpaces,
      "source_native_sections",
    ]);
    expect(createProjection(inputs[0]!).projectionId).toBe(createProjection(inputs[0]!).projectionId);
  });

  it("produces a different projectionId when procedureVersionId changes but the text does not", () => {
    const first = createProjection(inputs[0]!);
    const changed: ProjectionInput = { ...inputs[0]!, procedureVersionId: id(9) };
    const second = createProjection(changed);
    expect(second.text).toBe(first.text);
    expect(second.procedureVersionId).not.toBe(first.procedureVersionId);
    expect(second.projectionId).not.toBe(first.projectionId);
  });
});
