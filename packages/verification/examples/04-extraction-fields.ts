import {
  admitExtractionSchema,
  sha256Digest,
  verifyExtractionFieldsWithEvidence,
  type AdmittedExtractionSchema,
  type ExtractionFieldEvidenceResult,
} from "../src/index.js";

/**
 * Stage 3 — mechanical correctness for structured extraction. A schema is
 * admitted under bounds, a candidate is checked against it, and every field
 * must be backed by evidence that resolves in immutable representation bytes
 * to the same scalar. Decimal fields compare numerically, not textually.
 */
const sourceRecord = { vendor: "Northwind Labs", total: "12.50" };
const sourceBytes = new TextEncoder().encode(JSON.stringify(sourceRecord));
const sourceDigest = sha256Digest(sourceBytes);

export function admittedInvoiceSchema(): AdmittedExtractionSchema {
  const admission = admitExtractionSchema({
    schemaId: "invoice",
    schemaVersion: "1",
    schema: {
      type: "object",
      description: "Invoice header fields.",
      properties: {
        vendor: { type: "string", description: "Vendor name.", maxLength: 128 },
        total: { type: "string", description: "Invoice total.", maxLength: 32 },
      },
      required: ["vendor", "total"],
      additionalProperties: false,
    },
  });
  if (!admission.admitted) throw new Error(admission.checks.map((check) => check.code).join(","));
  return admission.schema;
}

/** The candidate writes the total as `12.5`; the source says `12.50`. */
export function extractionFieldsExample(
  candidate: unknown = { vendor: "Northwind Labs", total: "12.5" },
): ExtractionFieldEvidenceResult {
  return verifyExtractionFieldsWithEvidence({
    schema: admittedInvoiceSchema(),
    candidate,
    fields: [
      { path: "/vendor", comparison: "exact" },
      { path: "/total", comparison: "decimal" },
    ],
    evidence: ["/vendor", "/total"].map((path) => ({
      path,
      captureId: "capture-1",
      representationArtifactId: "artifact-1",
      representationDigest: sourceDigest,
      selector: { kind: "json_pointer", pointer: path },
    })),
    representations: [
      {
        captureId: "capture-1",
        artifactId: "artifact-1",
        digest: sourceDigest,
        content: sourceBytes,
      },
    ],
  });
}

export function acceptedLeaves(result: ExtractionFieldEvidenceResult) {
  return result.acceptedLeaves.map((leaf) => ({
    path: leaf.path,
    value: leaf.value,
    rawValue: leaf.rawValue,
    derivation: leaf.derivation.kind,
  }));
}
