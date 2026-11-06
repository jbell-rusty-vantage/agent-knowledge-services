import { describe, expect, it } from "vitest";
import type { ResolvedSelector } from "@aiengineer/knowledge-contracts";
import { canonicalizeJson, sha256Digest } from "../canonical/index.js";
import { projectionSelectorResolver } from "./projection-resolver.js";
import { resolveEvidenceSelector } from "./resolve-evidence-selector.js";
import type { EvidenceSelection, EvidenceSelectionRequest, EvidenceSelectorResolver } from "./selection.js";

const projectionBytes = new TextEncoder().encode(
  canonicalizeJson({
    kind: "dataset",
    datasetVersionId: "dataset-v1",
    rows: [{ key: "r1", value: { answer: 42 } }],
  }),
);
const datasetRequest: EvidenceSelectionRequest = {
  captureId: "capture-01",
  representationArtifactId: "11111111-1111-4111-8111-111111111111",
  representationDigest: sha256Digest(projectionBytes),
  selector: {
    kind: "dataset",
    datasetVersionId: "dataset-v1",
    rowKey: "r1",
    column: "answer",
  },
  content: projectionBytes,
};

/** Wraps a real resolver and lets a test tamper with what it claims. */
function tampered(edit: (honest: EvidenceSelection) => EvidenceSelection): EvidenceSelectorResolver {
  return {
    resolverVersion: projectionSelectorResolver.resolverVersion,
    supportedKinds: projectionSelectorResolver.supportedKinds,
    resolve: (request) => edit(projectionSelectorResolver.resolve(request)),
  };
}

const withReport = (selection: EvidenceSelection, patch: Partial<ResolvedSelector>): EvidenceSelection => ({
  ...selection,
  resolution: { ...selection.resolution, ...patch } as ResolvedSelector,
});

describe("resolveEvidenceSelector", () => {
  it("returns undefined when no resolver owns the selector kind", () => {
    expect(resolveEvidenceSelector(datasetRequest)).toBeUndefined();
    expect(resolveEvidenceSelector(datasetRequest, [])).toBeUndefined();
  });

  it("accepts an honest resolver and attaches the decoded text", () => {
    const selection = resolveEvidenceSelector(datasetRequest, [projectionSelectorResolver]);
    expect(selection?.resolution.status).toBe("resolved");
    expect(selection?.resolution.resolverVersion).toBe("verification-projections.v1");
    expect(selection?.selectedText).toBe("42");
    expect(sha256Digest(selection!.selectedContent)).toBe(selection!.resolution.selectedContentDigest);
  });

  it.each([
    ["captureId", { captureId: "another-capture" }],
    ["representationArtifactId", { representationArtifactId: "22222222-2222-4222-8222-222222222222" }],
    ["representationDigest", { representationDigest: sha256Digest("other") }],
    ["selectorDigest", { selectorDigest: sha256Digest("other") }],
    ["selectorKind", { selectorKind: "table" }],
    ["resolverVersion", { resolverVersion: "somebody-else.v9" }],
  ] as const)("rejects a claim whose %s does not bind to the request", (_field, patch) => {
    const selection = resolveEvidenceSelector(datasetRequest, [tampered((honest) => withReport(honest, patch))]);
    expect(selection?.resolution.status).toBe("invalid");
    expect(selection?.selectedContent).toHaveLength(0);
  });

  it("rejects a claim whose selected bytes do not replay to the reported digest", () => {
    const swappedBytes = tampered((honest) => ({
      ...honest,
      selectedContent: new TextEncoder().encode("41"),
    }));
    expect(resolveEvidenceSelector(datasetRequest, [swappedBytes])?.resolution.status).toBe("invalid");
    const swappedValue = tampered((honest) => withReport(honest, { selectedValue: 41 as never }));
    expect(resolveEvidenceSelector(datasetRequest, [swappedValue])?.resolution.status).toBe("invalid");
  });

  it("rejects a claim whose selectedContentDigest disagrees with the bytes it returned", () => {
    const forgedDigest = tampered((honest) => withReport(honest, { selectedContentDigest: sha256Digest("other") }));
    expect(resolveEvidenceSelector(datasetRequest, [forgedDigest])?.resolution.status).toBe("invalid");
  });

  it("resolves core kinds itself even when a resolver claims to support them", () => {
    const text = new TextEncoder().encode("The count is 42.");
    const hijacker: EvidenceSelectorResolver = {
      resolverVersion: "hijack.v1",
      supportedKinds: ["text_quote"],
      resolve: () => {
        throw new Error("must not be called");
      },
    };
    const selection = resolveEvidenceSelector(
      {
        ...datasetRequest,
        representationDigest: sha256Digest(text),
        content: text,
        selector: { kind: "text_quote", quote: "42", normalization: "none" },
      },
      [hijacker],
    );
    expect(selection?.resolution.resolverVersion).toBe("verification-core.v1");
    expect(selection?.selectedText).toBe("42");
  });
});
