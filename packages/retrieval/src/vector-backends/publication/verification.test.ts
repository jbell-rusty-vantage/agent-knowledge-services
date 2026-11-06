import { describe, expect, it } from "vitest";
import { CANONICAL_EMBEDDING_DIMENSIONS, VectorBackendError } from "../types.js";
import { collectInspectionFindings, verifyInspection } from "./verification.js";
import type { ExploratoryPublication, PublicationInspection, PublicationManifests } from "./types.js";

const digest = (character: string) => `sha256:${character.repeat(64)}` as const;
const manifests: PublicationManifests = {
  source: digest("1"),
  representation: digest("2"),
  chunkSet: digest("3"),
  projection: digest("4"),
  vectorItem: digest("5"),
  embedding: digest("6"),
  index: digest("7"),
  retrievalPolicy: digest("8"),
  evaluation: digest("9"),
};

function inspection(overrides: Partial<PublicationInspection> = {}): PublicationInspection {
  return {
    vectorSpaceVersionId: "v1",
    itemCount: 2,
    dimensions: CANONICAL_EMBEDDING_DIMENSIONS,
    precision: "halfvec",
    manifests,
    indexReady: true,
    authorizationPassed: true,
    evaluationPassed: true,
    sampleSearchPassed: true,
    ...overrides,
  };
}

function publication(overrides: Partial<ExploratoryPublication> = {}): ExploratoryPublication {
  return {
    id: "publication-1",
    tenantId: "tenant-1",
    vectorStoreId: "store-1",
    vectorStoreSpaceId: "space-1",
    vectorSpaceVersionId: "v1",
    storeClass: "internal_exploratory",
    expectedItemCount: 2,
    dimensions: CANONICAL_EMBEDDING_DIMENSIONS,
    manifests,
    promotionDecisionId: "decision-1",
    evaluationGateResultId: "gate-1",
    state: "published",
    verificationDigest: digest("a"),
    receiptId: "receipt-1",
    publishedAt: "2026-09-03T12:00:00Z",
    ...overrides,
  };
}

describe("verifyInspection", () => {
  it("returns a stable digest for a matching inspection, independent of call order", () => {
    const first = verifyInspection("v1", 2, manifests, inspection());
    const second = verifyInspection("v1", 2, manifests, inspection());
    expect(first).toBe(second);
    expect(first).toMatch(/^sha256:/);
  });

  it("throws PUBLICATION_VERIFICATION_FAILED joining every mismatch in check order", () => {
    const bad = inspection({
      vectorSpaceVersionId: "v2",
      itemCount: 1,
      dimensions: 1,
      precision: "vector",
      indexReady: false,
      authorizationPassed: false,
      evaluationPassed: false,
      sampleSearchPassed: false,
    });
    let caught: VectorBackendError | undefined;
    try {
      verifyInspection("v1", 2, manifests, bad);
    } catch (error) {
      caught = error as VectorBackendError;
    }
    expect(caught).toBeInstanceOf(VectorBackendError);
    expect(caught?.code).toBe("PUBLICATION_VERIFICATION_FAILED");
    expect(caught?.message).toBe(
      `vector-space version mismatch; item count 1/2; dimensions 1/${CANONICAL_EMBEDDING_DIMENSIONS}; precision vector/halfvec; index not ready; authorization verification failed; evaluation gate failed; sample search failed`,
    );
  });

  it("checks candidateEvidenceDigest and requiredDependenciesEligible only when a candidate digest is requested", () => {
    expect(() => verifyInspection("v1", 2, manifests, inspection())).not.toThrow();
    const wrongDigest = inspection({ candidateEvidenceDigest: digest("z"), requiredDependenciesEligible: true });
    expect(() => verifyInspection("v1", 2, manifests, wrongDigest, digest("expected"))).toThrowError(
      /candidate evidence digest mismatch/,
    );
    const revokedDependency = inspection({
      candidateEvidenceDigest: digest("expected"),
      requiredDependenciesEligible: false,
    });
    expect(() => verifyInspection("v1", 2, manifests, revokedDependency, digest("expected"))).toThrowError(
      /required dependency revoked/,
    );
  });

  it("does not include candidateEvidenceDigest or requiredDependenciesEligible in the returned digest's input", () => {
    const withoutCandidate = verifyInspection("v1", 2, manifests, inspection());
    const withCandidate = verifyInspection(
      "v1",
      2,
      manifests,
      inspection({ candidateEvidenceDigest: digest("expected"), requiredDependenciesEligible: true }),
      digest("expected"),
    );
    expect(withCandidate).toBe(withoutCandidate);
  });
});

describe("collectInspectionFindings", () => {
  it("reports no findings for a matching inspection", () => {
    const findings: Parameters<typeof collectInspectionFindings>[2] = [];
    collectInspectionFindings(publication(), inspection(), findings);
    expect(findings).toEqual([]);
  });

  it("classifies a version mismatch as security_critical", () => {
    const findings: Parameters<typeof collectInspectionFindings>[2] = [];
    collectInspectionFindings(publication(), inspection({ vectorSpaceVersionId: "v2" }), findings);
    expect(findings).toEqual([
      { code: "VERSION_MISMATCH", classification: "security_critical", detail: expect.any(String) },
    ]);
  });

  it("classifies a count mismatch as repairable", () => {
    const findings: Parameters<typeof collectInspectionFindings>[2] = [];
    collectInspectionFindings(publication(), inspection({ itemCount: 1 }), findings);
    expect(findings).toEqual([{ code: "COUNT_MISMATCH", classification: "repairable", detail: expect.any(String) }]);
  });

  it("classifies a vector format change (dimensions or precision) as security_critical", () => {
    const findings: Parameters<typeof collectInspectionFindings>[2] = [];
    collectInspectionFindings(publication(), inspection({ precision: "vector" }), findings);
    expect(findings).toEqual([
      { code: "VECTOR_FORMAT_MISMATCH", classification: "security_critical", detail: expect.any(String) },
    ]);
  });

  it("names the mismatched manifest key and classifies it security_critical", () => {
    const findings: Parameters<typeof collectInspectionFindings>[2] = [];
    collectInspectionFindings(
      publication(),
      inspection({ manifests: { ...manifests, embedding: digest("z") } }),
      findings,
    );
    expect(findings).toEqual([
      { code: "EMBEDDING_MANIFEST_MISMATCH", classification: "security_critical", detail: expect.any(String) },
    ]);
  });

  it("classifies an unready index as repairable and a failed authorization check as security_critical", () => {
    const findings: Parameters<typeof collectInspectionFindings>[2] = [];
    collectInspectionFindings(publication(), inspection({ indexReady: false, authorizationPassed: false }), findings);
    expect(findings.map(({ code, classification }) => [code, classification])).toEqual([
      ["INDEX_NOT_READY", "repairable"],
      ["AUTHORIZATION_CHECK_FAILED", "security_critical"],
    ]);
  });

  it("classifies an evaluation regression as review_required and a failed sample search as repairable", () => {
    const findings: Parameters<typeof collectInspectionFindings>[2] = [];
    collectInspectionFindings(
      publication(),
      inspection({ evaluationPassed: false, sampleSearchPassed: false }),
      findings,
    );
    expect(findings.map(({ code, classification }) => [code, classification])).toEqual([
      ["EVALUATION_REGRESSION", "review_required"],
      ["SAMPLE_SEARCH_FAILED", "repairable"],
    ]);
  });

  it("checks candidate evidence only when the publication carries one, classifying digest drift security_critical and dependency revocation review_required", () => {
    const withoutCandidate: Parameters<typeof collectInspectionFindings>[2] = [];
    collectInspectionFindings(publication(), inspection(), withoutCandidate);
    expect(withoutCandidate).toEqual([]);

    const withDriftedDigest: Parameters<typeof collectInspectionFindings>[2] = [];
    collectInspectionFindings(
      publication({ candidateEvidenceDigest: digest("expected") }),
      inspection({ candidateEvidenceDigest: digest("drifted"), requiredDependenciesEligible: true }),
      withDriftedDigest,
    );
    expect(withDriftedDigest).toEqual([
      { code: "CANDIDATE_EVIDENCE_MISMATCH", classification: "security_critical", detail: expect.any(String) },
    ]);

    const withRevokedDependency: Parameters<typeof collectInspectionFindings>[2] = [];
    collectInspectionFindings(
      publication({ candidateEvidenceDigest: digest("expected") }),
      inspection({ candidateEvidenceDigest: digest("expected"), requiredDependenciesEligible: false }),
      withRevokedDependency,
    );
    expect(withRevokedDependency).toEqual([
      { code: "REQUIRED_DEPENDENCY_REVOKED", classification: "review_required", detail: expect.any(String) },
    ]);
  });
});
