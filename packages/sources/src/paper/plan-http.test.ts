import { describe, expect, it } from "vitest";
import { planPaperAsHttpRequest } from "./plan-http.js";
import { normalizePaperIdentifier } from "./identity.js";
import type { AcquisitionRequest, PaperResolution } from "../types.js";

const defaults: Omit<AcquisitionRequest, "target"> = {
  tenantId: "tenant",
  purpose: "capture",
  expectedSourceClass: "pdf",
  preferredMediaTypes: [],
  egressProfile: "public-web",
  maximumBytes: 1_000,
  renderingPolicy: "none",
  interactionPolicy: "none",
  classification: "public",
  expectedOutputs: ["source_native"],
};

describe("planPaperAsHttpRequest", () => {
  it("normalizes identities and emits one HTTPS request", () => {
    expect(normalizePaperIdentifier("doi", "https://doi.org/10.1234/ABC")).toBe("10.1234/abc");
    expect(normalizePaperIdentifier("arxiv", "arXiv:2401.12345v2")).toBe("2401.12345v2");
    expect(normalizePaperIdentifier("openreview", "https://openreview.net/forum?id=abcdef_12")).toBe("abcdef_12");
    const resolution: PaperResolution = {
      identifierKind: "doi",
      identifier: "10.1234/abc",
      title: "Paper",
      authors: ["Author"],
      revision: "v1",
      publicationState: "published",
      correctionState: "none",
      representations: [
        { mediaType: "text/html", url: "https://papers.example/p.html" },
        { mediaType: "application/pdf", url: "https://papers.example/p.pdf" },
      ],
    };
    const request = planPaperAsHttpRequest(resolution, defaults);
    expect(request.target).toEqual({ kind: "http", url: "https://papers.example/p.pdf" });
    expect(request.preferredMediaTypes).toEqual(["application/pdf"]);
  });
});
