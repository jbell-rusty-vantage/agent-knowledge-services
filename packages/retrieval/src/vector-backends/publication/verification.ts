import { sha256Digest } from "@aiengineer/knowledge-core";
import { CANONICAL_EMBEDDING_DIMENSIONS, VectorBackendError } from "../types.js";
import type {
  Digest,
  ExploratoryPublication,
  PublicationInspection,
  PublicationManifests,
  ReconciliationFinding,
} from "./types.js";

// Finding order and the digest's input object are load-bearing: the digest is
// a published verification digest, so neither may change independent of an
// actual verification-policy decision (Phase 2 memo §7 item 6 tracks the one
// known gap — precision's type admits values this check rejects).
export function verifyInspection(
  versionId: string,
  count: number,
  manifests: PublicationManifests,
  inspection: PublicationInspection,
  candidateEvidenceDigest?: Digest,
): Digest {
  const findings: string[] = [];
  if (candidateEvidenceDigest !== undefined) {
    if (inspection.candidateEvidenceDigest !== candidateEvidenceDigest)
      findings.push("candidate evidence digest mismatch");
    if (inspection.requiredDependenciesEligible !== true) findings.push("required dependency revoked");
  }
  if (inspection.vectorSpaceVersionId !== versionId) findings.push("vector-space version mismatch");
  if (inspection.itemCount !== count) findings.push(`item count ${inspection.itemCount}/${count}`);
  if (inspection.dimensions !== CANONICAL_EMBEDDING_DIMENSIONS)
    findings.push(`dimensions ${inspection.dimensions}/${CANONICAL_EMBEDDING_DIMENSIONS}`);
  if (inspection.precision !== "halfvec") findings.push(`precision ${inspection.precision}/halfvec`);
  for (const key of manifestKeys)
    if (inspection.manifests[key] !== manifests[key]) findings.push(`${key} manifest mismatch`);
  if (!inspection.indexReady) findings.push("index not ready");
  if (!inspection.authorizationPassed) findings.push("authorization verification failed");
  if (!inspection.evaluationPassed) findings.push("evaluation gate failed");
  if (!inspection.sampleSearchPassed) findings.push("sample search failed");
  if (findings.length > 0) throw new VectorBackendError("PUBLICATION_VERIFICATION_FAILED", findings.join("; "));
  return sha256Digest(
    JSON.stringify({
      versionId,
      count,
      dimensions: inspection.dimensions,
      precision: inspection.precision,
      manifests,
      indexReady: true,
      authorizationPassed: true,
      evaluationPassed: true,
      sampleSearchPassed: true,
    }),
  );
}

export function collectInspectionFindings(
  publication: ExploratoryPublication,
  inspection: PublicationInspection,
  findings: ReconciliationFinding[],
): void {
  if (inspection.vectorSpaceVersionId !== publication.vectorSpaceVersionId)
    findings.push({
      code: "VERSION_MISMATCH",
      classification: "security_critical",
      detail: "Inspected version does not match publication",
    });
  if (inspection.itemCount !== publication.expectedItemCount)
    findings.push({
      code: "COUNT_MISMATCH",
      classification: "repairable",
      detail: `Expected ${publication.expectedItemCount}, observed ${inspection.itemCount}`,
    });
  if (inspection.dimensions !== publication.dimensions || inspection.precision !== "halfvec")
    findings.push({
      code: "VECTOR_FORMAT_MISMATCH",
      classification: "security_critical",
      detail: "Published vector format changed",
    });
  for (const key of manifestKeys)
    if (inspection.manifests[key] !== publication.manifests[key])
      findings.push({
        code: `${key.toUpperCase()}_MANIFEST_MISMATCH`,
        classification: "security_critical",
        detail: `${key} manifest does not match publication`,
      });
  if (!inspection.indexReady)
    findings.push({
      code: "INDEX_NOT_READY",
      classification: "repairable",
      detail: "Published index is unavailable",
    });
  if (!inspection.authorizationPassed)
    findings.push({
      code: "AUTHORIZATION_CHECK_FAILED",
      classification: "security_critical",
      detail: "Authorization verification failed",
    });
  if (!inspection.evaluationPassed)
    findings.push({
      code: "EVALUATION_REGRESSION",
      classification: "review_required",
      detail: "Evaluation gate no longer passes",
    });
  if (!inspection.sampleSearchPassed)
    findings.push({
      code: "SAMPLE_SEARCH_FAILED",
      classification: "repairable",
      detail: "Immediate sample search failed",
    });
  if (publication.candidateEvidenceDigest !== undefined) {
    if (inspection.candidateEvidenceDigest !== publication.candidateEvidenceDigest)
      findings.push({
        code: "CANDIDATE_EVIDENCE_MISMATCH",
        classification: "security_critical",
        detail: "Published candidate evidence digest changed",
      });
    if (inspection.requiredDependenciesEligible !== true)
      findings.push({
        code: "REQUIRED_DEPENDENCY_REVOKED",
        classification: "review_required",
        detail: "A required publication dependency was revoked",
      });
  }
}

const manifestKeys = [
  "source",
  "representation",
  "chunkSet",
  "projection",
  "vectorItem",
  "embedding",
  "index",
  "retrievalPolicy",
  "evaluation",
] as const;
