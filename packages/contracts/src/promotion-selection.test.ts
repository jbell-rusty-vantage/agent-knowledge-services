import { describe, expect, it } from "vitest";
import { PromotionSelectionSchema, type PromotionSelection } from "./promotion-selection.js";
import { SelectedCandidateIndexInputSchema } from "./vector-store.js";

const id = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
const digest = `sha256:${"a".repeat(64)}`;

function selection(): PromotionSelection {
  return {
    schemaVersion: "promotion-selection.v1",
    tenantId: id(1),
    expectedKnowledgeHead: 12,
    runPinDigest: digest,
    policyDigest: digest,
    selected: [
      {
        memberId: "capability",
        content: { kind: "chunk", id: id(2), digest },
        target: { projectionTargetId: id(3), kind: "claim", canonicalId: id(4) },
        targetSpaces: ["model_capabilities"],
        sourceChunks: [
          {
            chunkId: id(2),
            chunkDigest: digest,
            representationId: id(5),
            representationDigest: digest,
            representationClass: "faithful_normalization",
            captureId: id(6),
            sourceFamilyId: "official-model-docs",
          },
        ],
        admittedClaims: [{ runId: "run-a", claimId: "capability", claimDigest: digest, admissionDigest: digest }],
        contentLinkReceiptIds: [id(7)],
        reason: "Preserves the supported capability and its qualification.",
        estimatedBytes: 100,
        estimatedTokens: 30,
        estimatedCostMicros: 100,
      },
    ],
    excluded: [
      {
        content: { kind: "chunk", id: id(8), digest },
        targetSpaces: ["model_capabilities"],
        reason: "The assertion was rejected.",
      },
    ],
    budget: { maxMembers: 2, maxBytes: 200, maxTokens: 60, maxCostMicros: 1_000, deadline: "2026-09-15T00:00:00Z" },
    proposedBy: "preparer",
    requiredReviewer: "independent-reviewer",
  };
}

describe("selected candidate index contract", () => {
  const candidate = () => ({
    schemaVersion: "knowledge.selected-candidate-index/v1",
    selection: selection(),
    selectionArtifact: { id: id(30), digest },
    preparation: { operationId: id(31), receiptId: id(32), proposalId: id(33) },
    review: { operationId: id(34), receiptId: id(35), decisionId: id(36) },
    embeddings: [
      {
        operationId: id(37),
        receiptId: id(38),
        embeddingRunId: id(39),
        vectorSpaceVersionId: id(40),
        projectionIds: [id(41)],
      },
    ],
  });
  it("retains preparation, review and embedding receipt bindings without publication", () => {
    expect(SelectedCandidateIndexInputSchema.parse(candidate())).toEqual(candidate());
  });
  it("rejects missing review receipt instead of accepting a decision label", () => {
    const input = candidate();
    expect(
      SelectedCandidateIndexInputSchema.safeParse({ ...input, review: { ...input.review, receiptId: undefined } })
        .success,
    ).toBe(false);
  });
  it("rejects duplicate candidate versions", () => {
    const input = candidate();
    input.embeddings.push(input.embeddings[0]!);
    expect(SelectedCandidateIndexInputSchema.safeParse(input).success).toBe(false);
  });
  it("rejects duplicate projections within a candidate version", () => {
    const input = candidate();
    input.embeddings[0]!.projectionIds.push(id(41));
    expect(SelectedCandidateIndexInputSchema.safeParse(input).success).toBe(false);
  });
  it("rejects publication as an implicit index prerequisite or permission", () => {
    expect(SelectedCandidateIndexInputSchema.safeParse({ ...candidate(), publicationId: id(42) }).success).toBe(false);
  });
});

describe("explicit promotion selection", () => {
  it("retains exact source, canonical target, evidence and exclusion bindings", () => {
    const input = selection();
    expect(PromotionSelectionSchema.parse(input)).toEqual(input);
  });

  it("allows faithful context in a source space while excluding it from an official domain", () => {
    const input = selection();
    const member = input.selected[0]!;
    member.target = { projectionTargetId: id(9), kind: "chunk", canonicalId: member.content.id };
    member.targetSpaces = ["source_native_sections"];
    member.admittedClaims = [];
    input.excluded = [
      {
        content: member.content,
        targetSpaces: ["model_capabilities"],
        reason: "Context is not an admitted domain claim.",
      },
    ];
    expect(PromotionSelectionSchema.safeParse(input).success).toBe(true);
  });

  it("preserves identical local claim names from separate verification runs", () => {
    const input = selection();
    input.selected[0]!.admittedClaims.push({ ...input.selected[0]!.admittedClaims[0]!, runId: "run-b" });
    expect(PromotionSelectionSchema.safeParse(input).success).toBe(true);
  });

  const rejected: [string, (input: PromotionSelection) => void][] = [
    [
      "domain label without canonical target",
      (input) => {
        input.selected[0]!.target.kind = "chunk";
        input.selected[0]!.target.canonicalId = id(2);
      },
    ],
    [
      "domain target without admitted claim bindings",
      (input) => {
        input.selected[0]!.admittedClaims = [];
      },
    ],
    [
      "selected and excluded membership in one space",
      (input) => {
        input.excluded[0]!.content = input.selected[0]!.content;
      },
    ],
    [
      "changed digest for one content identity",
      (input) => {
        input.excluded[0]!.content = { ...input.selected[0]!.content, digest: `sha256:${"b".repeat(64)}` };
      },
    ],
    [
      "duplicate member",
      (input) => {
        input.selected.push(structuredClone(input.selected[0]!));
      },
    ],
    [
      "duplicate content/target with a new label",
      (input) => {
        input.selected.push({ ...structuredClone(input.selected[0]!), memberId: "duplicate" });
      },
    ],
    [
      "duplicate target space",
      (input) => {
        input.selected[0]!.targetSpaces.push("model_capabilities");
      },
    ],
    [
      "duplicate source chunk",
      (input) => {
        input.selected[0]!.sourceChunks.push(input.selected[0]!.sourceChunks[0]!);
      },
    ],
    [
      "duplicate admission identity",
      (input) => {
        input.selected[0]!.admittedClaims.push(input.selected[0]!.admittedClaims[0]!);
      },
    ],
    [
      "missing content link receipt",
      (input) => {
        input.selected[0]!.contentLinkReceiptIds = [];
      },
    ],
    [
      "chunk not bound to source bytes",
      (input) => {
        input.selected[0]!.sourceChunks[0]!.chunkDigest = `sha256:${"b".repeat(64)}`;
      },
    ],
    [
      "derived text in source-native sections",
      (input) => {
        input.selected[0]!.targetSpaces = ["source_native_sections"];
        input.selected[0]!.sourceChunks[0]!.representationClass = "semantic_projection";
      },
    ],
    [
      "self review",
      (input) => {
        input.requiredReviewer = input.proposedBy;
      },
    ],
    [
      "byte reservation exceeded",
      (input) => {
        input.budget.maxBytes = 99;
      },
    ],
    [
      "token reservation exceeded",
      (input) => {
        input.budget.maxTokens = 29;
      },
    ],
    [
      "cost reservation exceeded",
      (input) => {
        input.budget.maxCostMicros = 99;
      },
    ],
    [
      "selected canonical claim target mismatch",
      (input) => {
        input.selected[0]!.content = { kind: "claim", id: id(20), digest };
      },
    ],
    [
      "unbounded unsafe numeric estimate",
      (input) => {
        input.selected[0]!.estimatedTokens = Number.MAX_SAFE_INTEGER + 1;
      },
    ],
    [
      "duplicate exclusion",
      (input) => {
        input.excluded.push(structuredClone(input.excluded[0]!));
      },
    ],
  ];
  it.each(rejected)("rejects %s", (_name, change) => {
    const input = selection();
    change(input);
    expect(PromotionSelectionSchema.safeParse(input).success).toBe(false);
  });

  it("rejects aggregate overrun even when each member is individually bounded", () => {
    const input = selection();
    const other = structuredClone(input.selected[0]!);
    other.memberId = "other-claim";
    other.target = { projectionTargetId: id(10), kind: "claim", canonicalId: id(11) };
    other.estimatedTokens = 31;
    input.selected.push(other);
    expect(PromotionSelectionSchema.safeParse(input).success).toBe(false);
  });

  it("does not strip an unknown field that could change membership semantics", () => {
    expect(PromotionSelectionSchema.safeParse({ ...selection(), includeAllChunks: true }).success).toBe(false);
  });

  it.each([
    [
      "target ID with different canonical identity",
      (input: PromotionSelection) => {
        input.selected[1]!.target.projectionTargetId = id(3);
      },
    ],
    [
      "canonical identity with different target ID",
      (input: PromotionSelection) => {
        input.selected[1]!.target.canonicalId = id(4);
        input.selected[1]!.content.id = id(4);
      },
    ],
    [
      "chunk digest across members",
      (input: PromotionSelection) => {
        input.selected[1]!.sourceChunks[0]!.chunkDigest = `sha256:${"b".repeat(64)}`;
      },
    ],
    [
      "representation digest across distinct chunks",
      (input: PromotionSelection) => {
        input.selected[1]!.sourceChunks[0]!.chunkId = id(22);
        input.selected[1]!.sourceChunks[0]!.representationDigest = `sha256:${"b".repeat(64)}`;
      },
    ],
    [
      "claim digest across members",
      (input: PromotionSelection) => {
        input.selected[1]!.admittedClaims[0]!.claimDigest = `sha256:${"b".repeat(64)}`;
      },
    ],
    [
      "admission digest across members",
      (input: PromotionSelection) => {
        input.selected[1]!.admittedClaims[0]!.admissionDigest = `sha256:${"b".repeat(64)}`;
      },
    ],
  ] as const)("rejects inconsistent %s", (_name, change) => {
    const input = selection();
    const other = structuredClone(input.selected[0]!);
    other.memberId = "other";
    other.content = { kind: "claim", id: id(20), digest };
    other.target = { kind: "claim", canonicalId: id(20), projectionTargetId: id(21) };
    input.selected.push(other);
    expect(PromotionSelectionSchema.safeParse(input).success).toBe(true);
    change(input);
    expect(PromotionSelectionSchema.safeParse(input).success).toBe(false);
  });
});
