import { describe, expect, it } from "vitest";
import { InMemoryArtifactStore } from "@aiengineer/knowledge-core";
import { IdentityBoundPaperAcquisitionAdapter } from "./adapter.js";
import { normalizePaperIdentifier } from "./identity.js";
import type { AcquisitionRequest, PaperResolution } from "../types.js";

const bytes = (value: string) => new TextEncoder().encode(value);
function request(target: AcquisitionRequest["target"], maximumBytes = 10_000): AcquisitionRequest {
  return {
    tenantId: "tenant-1",
    purpose: "test",
    target,
    expectedSourceClass: "official",
    preferredMediaTypes: ["text/markdown"],
    egressProfile: "public-web",
    maximumBytes,
    renderingPolicy: "allowed",
    interactionPolicy: "none",
    classification: "public",
    expectedOutputs: ["source_native"],
  };
}

describe("IdentityBoundPaperAcquisitionAdapter", () => {
  const resolution = (kind: "doi" | "arxiv" | "openreview", identifier: string): PaperResolution => ({
    identifierKind: kind,
    identifier,
    title: "Paper",
    authors: ["Author"],
    revision: "v1",
    publicationState: "published",
    correctionState: "none",
    representations: [{ mediaType: "application/pdf", url: "https://papers.example/p.pdf" }],
  });
  it("normalizes all identities and requires matching provider identity", async () => {
    expect(normalizePaperIdentifier("doi", "https://doi.org/10.1234/ABC")).toBe("10.1234/abc");
    expect(normalizePaperIdentifier("arxiv", "arXiv:2401.12345v2")).toBe("2401.12345v2");
    expect(normalizePaperIdentifier("openreview", "https://openreview.net/forum?id=abcdef_12")).toBe("abcdef_12");
    const adapter = new IdentityBoundPaperAcquisitionAdapter(new InMemoryArtifactStore(), {
      resolve: async (kind, identifier) => ({
        resolution: resolution(kind, identifier),
        representations: [{ mediaType: "application/pdf", url: "https://papers.example/p.pdf", bytes: bytes("pdf") }],
      }),
    });
    const plan = await adapter.plan(request({ kind: "paper", identifierKind: "doi", identifier: "DOI:10.1234/ABC" }));
    const result = await adapter.execute({ ...plan, admissionId: "paper" });
    expect(result.discoveredCanonicalIdentifiers).toEqual(["doi:10.1234/abc"]);
    expect((await adapter.verify(result)).accepted).toBe(true);
  });
  it("rejects malformed and substituted identities", async () => {
    const adapter = new IdentityBoundPaperAcquisitionAdapter(new InMemoryArtifactStore(), {
      resolve: async () => ({
        resolution: resolution("doi", "10.9999/wrong"),
        representations: [{ mediaType: "application/pdf", url: "https://papers.example/p.pdf", bytes: bytes("pdf") }],
      }),
    });
    await expect(
      adapter.plan(request({ kind: "paper", identifierKind: "doi", identifier: "not-doi" })),
    ).rejects.toThrow("DOI_IDENTITY_INVALID");
    const plan = await adapter.plan(request({ kind: "paper", identifierKind: "doi", identifier: "10.1234/right" }));
    await expect(adapter.execute({ ...plan, admissionId: "wrong" })).rejects.toThrow("PAPER_IDENTITY_MISMATCH");
  });
});
