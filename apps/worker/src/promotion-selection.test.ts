import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { PromotionProposalInputSchema } from "@aiengineer/knowledge-contracts";
import {
  composePromotionSelectionWorkerHost,
  createCanonicalPromotionSelectionApplication,
  parsePromotionSelectionAuthorityLocator,
  resolvePromotionSelectionHost,
  type CanonicalPromotionSelectionConfiguration,
} from "./promotion-selection.js";

function fixture() {
  const digest = `sha256:${"a".repeat(64)}`,
    tenantId = randomUUID(),
    claimId = randomUUID(),
    chunkId = randomUUID();
  const transaction = vi.fn(async () => {
    throw new Error("unexpected database dispatch");
  });
  const proposal = PromotionProposalInputSchema.parse({
    schemaVersion: "knowledge.promotion-proposal/v1",
    selectionArtifact: { id: randomUUID(), digest },
    chunkSetId: randomUUID(),
    representationDecisionId: randomUUID(),
    projectionProcedureId: randomUUID(),
    purpose: "Selected native adapter",
    contextualPrefix: "",
    visibility: "internal",
    classification: "internal",
    targetDomains: ["engineering_claims"],
    expectedValue: "Qualified source evidence",
    risks: [],
    exclusions: [],
    reason: "Adapter proof",
    selection: {
      schemaVersion: "promotion-selection.v1",
      tenantId,
      expectedKnowledgeHead: 1,
      runPinDigest: digest,
      policyDigest: digest,
      proposedBy: randomUUID(),
      requiredReviewer: randomUUID(),
      budget: { maxMembers: 1, maxBytes: 1000, maxTokens: 1000, maxCostMicros: 0, deadline: "2099-01-01T00:00:00Z" },
      excluded: [],
      selected: [
        {
          memberId: "claim",
          content: { kind: "claim", id: claimId, digest },
          target: { kind: "claim", canonicalId: claimId, projectionTargetId: randomUUID() },
          targetSpaces: ["engineering_claims"],
          sourceChunks: [
            {
              chunkId,
              chunkDigest: digest,
              representationId: randomUUID(),
              representationDigest: digest,
              representationClass: "structural_extraction",
              captureId: randomUUID(),
              sourceFamilyId: "primary",
            },
          ],
          admittedClaims: [{ runId: "run", claimId: "claim", claimDigest: digest, admissionDigest: digest }],
          contentLinkReceiptIds: [randomUUID()],
          reason: "Admitted selection",
          estimatedBytes: 1,
          estimatedTokens: 1,
          estimatedCostMicros: 0,
        },
      ],
    },
  });
  const configuration: CanonicalPromotionSelectionConfiguration = {
    database: { transaction } as never,
    governance: {} as never,
    authority: {} as never,
    proposal,
    attemptId: randomUUID(),
    reviewerAttemptId: randomUUID(),
    correlationId: randomUUID(),
    capabilityVersion: "adapter.v1",
    embeddingExecutorId: randomUUID(),
    origin: "http://127.0.0.1:4100",
    spaces: [
      {
        space: "engineering_claims",
        vectorSpaceVersionId: randomUUID(),
        modelSlug: "fake",
        providerRoute: ["deterministic-fake"],
      },
    ],
  };
  return { configuration, transaction };
}

describe("canonical selected-promotion adapter pins", () => {
  it("rejects the producer attempt as the reviewer pin before dispatch", () => {
    const f = fixture();
    expect(() =>
      createCanonicalPromotionSelectionApplication({
        ...f.configuration,
        reviewerAttemptId: f.configuration.attemptId,
      }),
    ).toThrow("PROMOTION_REVIEW_PIN_MISMATCH");
    expect(f.transaction).not.toHaveBeenCalled();
  });
  it("rejects a missing provider route before dispatch", () => {
    const f = fixture();
    expect(() =>
      createCanonicalPromotionSelectionApplication({
        ...f.configuration,
        spaces: [{ ...f.configuration.spaces[0]!, providerRoute: [] }],
      }),
    ).toThrow();
    expect(f.transaction).not.toHaveBeenCalled();
  });
  it("rejects a missing selected-space pin before database dispatch", () => {
    const f = fixture();
    expect(() => createCanonicalPromotionSelectionApplication({ ...f.configuration, spaces: [] })).toThrow(
      "PROMOTION_SPACE_PINS_MISMATCH",
    );
    expect(f.transaction).not.toHaveBeenCalled();
  });
  it("rejects duplicate selected-space pins before database dispatch", () => {
    const f = fixture();
    expect(() =>
      createCanonicalPromotionSelectionApplication({
        ...f.configuration,
        spaces: [...f.configuration.spaces, ...f.configuration.spaces],
      }),
    ).toThrow("PROMOTION_SPACE_PINS_MISMATCH");
    expect(f.transaction).not.toHaveBeenCalled();
  });
  it("rejects altered selection bytes and foreign tenant before database dispatch", async () => {
    const f = fixture(),
      app = createCanonicalPromotionSelectionApplication(f.configuration);
    await expect(
      app.advance({
        selection: { ...f.configuration.proposal.selection, tenantId: randomUUID() },
        artifact: f.configuration.proposal.selectionArtifact,
      }),
    ).rejects.toThrow("PROMOTION_SELECTION_PIN_MISMATCH");
    expect(f.transaction).not.toHaveBeenCalled();
  });
  it("keeps its original selection when the caller changes the configuration object", async () => {
    const f = fixture(),
      app = createCanonicalPromotionSelectionApplication(f.configuration);
    f.configuration.proposal.selection.policyDigest = `sha256:${"b".repeat(64)}`;
    await expect(
      app.advance({
        selection: f.configuration.proposal.selection,
        artifact: f.configuration.proposal.selectionArtifact,
      }),
    ).rejects.toThrow("PROMOTION_SELECTION_PIN_MISMATCH");
    expect(f.transaction).not.toHaveBeenCalled();
  });
});

describe("promotion selection worker host composition", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const locator = { id: randomUUID(), digest };

  it("parses an authority locator and rejects partial or oversized JSON", () => {
    expect(parsePromotionSelectionAuthorityLocator({})).toBeUndefined();
    expect(
      parsePromotionSelectionAuthorityLocator({
        PROMOTION_SELECTION_AUTHORITY_ARTIFACT_JSON: JSON.stringify(locator),
      }),
    ).toEqual(locator);
    expect(() =>
      parsePromotionSelectionAuthorityLocator({
        PROMOTION_SELECTION_AUTHORITY_ARTIFACT_JSON: JSON.stringify({ id: locator.id }),
      }),
    ).toThrow("PROMOTION_SELECTION_RUNTIME_CONFIGURATION_INVALID");
    expect(() =>
      parsePromotionSelectionAuthorityLocator({
        PROMOTION_SELECTION_AUTHORITY_ARTIFACT_JSON: "{",
      }),
    ).toThrow("PROMOTION_SELECTION_RUNTIME_CONFIGURATION_INVALID");
    expect(() =>
      parsePromotionSelectionAuthorityLocator({
        PROMOTION_SELECTION_AUTHORITY_ARTIFACT_JSON: JSON.stringify({
          id: locator.id,
          digest,
          tenantId: randomUUID(),
        }),
      }),
    ).toThrow("PROMOTION_SELECTION_RUNTIME_CONFIGURATION_INVALID");
    expect(() =>
      parsePromotionSelectionAuthorityLocator({
        PROMOTION_SELECTION_AUTHORITY_ARTIFACT_JSON: `${"x".repeat(4_097)}`,
      }),
    ).toThrow("PROMOTION_SELECTION_RUNTIME_CONFIGURATION_TOO_LARGE");
  });

  it("fails closed when selection is requested without a composed authority", () => {
    expect(resolvePromotionSelectionHost({ host: {}, persistenceMode: "postgres" })).toBeUndefined();
    expect(() =>
      resolvePromotionSelectionHost({
        host: {},
        locator,
        persistenceMode: "postgres",
      }),
    ).toThrow("PROMOTION_SELECTION_AUTHORITY_REQUIRED");
    expect(() =>
      resolvePromotionSelectionHost({
        host: {
          promotionSelection: {
            selectionPorts: {} as never,
            selectionAuthority: async () => {
              throw new Error("unused");
            },
          },
        },
        persistenceMode: "memory",
      }),
    ).toThrow("PROMOTION_SELECTION_REQUIRES_POSTGRES");
  });

  it("composes the worker host from ports and an independently registered authority artifact", async () => {
    const ports = {
      readArtifact: vi.fn(async () => {
        throw new Error("unused");
      }),
    } as never;
    const host = composePromotionSelectionWorkerHost({ ports, authorityArtifact: locator });
    expect(host.promotionSelection.selectionPorts).toBe(ports);
    const resolved = resolvePromotionSelectionHost({ host, locator, persistenceMode: "postgres" });
    expect(resolved).toBe(host.promotionSelection);
  });
});
