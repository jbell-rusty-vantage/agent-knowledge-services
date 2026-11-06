import { describe, expect, it } from "vitest";
import { type VectorItemEntityLink, validateVectorItemEntityLink } from "./link.js";

const digest = (character: string) => `sha256:${character.repeat(64)}`;

function link(overrides: Partial<VectorItemEntityLink> = {}): VectorItemEntityLink {
  return {
    tenantId: "tenant-1",
    vectorSpaceVersionId: "version-1",
    vectorItemId: "item-1",
    searchProjectionId: "projection-1",
    target: { projectionTargetId: "target-1", kind: "chunk", canonicalId: "chunk-1" },
    lineage: {
      chunkId: "chunk-1",
      chunkDigest: digest("1"),
      representationId: "representation-1",
      representationDigest: digest("2"),
      captureId: "capture-1",
      sourceFamilyId: "family-1",
    },
    admission: { admissionDigest: digest("3"), admittedAt: "2026-09-19T00:00:00Z" },
    ...overrides,
  };
}

describe("validateVectorItemEntityLink", () => {
  it("is complete with no issues for a fully bound, admitted link", () => {
    expect(validateVectorItemEntityLink(link())).toEqual({ complete: true, issues: [] });
  });

  it("reports every empty identity field", () => {
    const result = validateVectorItemEntityLink(link({ tenantId: "", vectorItemId: "  " }));
    expect(result.complete).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining(["tenantId is empty", "vectorItemId is empty"]));
  });

  it("flags a chunk target whose canonicalId does not equal lineage.chunkId", () => {
    const result = validateVectorItemEntityLink(
      link({ target: { projectionTargetId: "target-1", kind: "chunk", canonicalId: "different-chunk" } }),
    );
    expect(result.issues).toContain("chunk target canonicalId must equal lineage.chunkId");
  });

  it("does not require canonicalId to equal chunkId for a non-chunk target", () => {
    const result = validateVectorItemEntityLink(
      link({ target: { projectionTargetId: "target-1", kind: "entity", canonicalId: "entity-1" } }),
    );
    expect(result.issues).not.toContain("chunk target canonicalId must equal lineage.chunkId");
  });

  it("rejects a digest that does not match the sha256 pattern", () => {
    const result = validateVectorItemEntityLink(link({ lineage: { ...link().lineage, chunkDigest: "not-a-digest" } }));
    expect(result.issues).toContain("lineage.chunkDigest is not a sha256 digest");
  });

  it("reports a not_admitted admission as an issue, never throwing", () => {
    const result = validateVectorItemEntityLink(link({ admission: { state: "not_admitted" } }));
    expect(result.complete).toBe(false);
    expect(result.issues).toContain("admission is not_admitted");
  });

  it("validates the admission digest when the link is admitted", () => {
    const result = validateVectorItemEntityLink(
      link({ admission: { admissionDigest: "bad", admittedAt: "2026-09-19T00:00:00Z" } }),
    );
    expect(result.issues).toContain("admission.admissionDigest is not a sha256 digest");
  });
});
