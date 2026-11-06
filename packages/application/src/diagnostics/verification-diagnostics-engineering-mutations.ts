import {
  admitExtractionSchema,
  projectionSelectorResolver,
  resolveEvidenceSelector,
  sha256Digest,
  verifyExtractionFields,
} from "@aiengineer/knowledge-verification";
import {
  verifyDiagnosticsAdversarialProjection,
  type DiagnosticsAdversarialProjectionInput,
} from "./verification-diagnostics-adversarial.js";
export type DiagnosticsEngineeringMutationFamily = "names" | "biomarkers" | "institutions" | "citations";
export interface DiagnosticsEngineeringMutation {
  readonly family: DiagnosticsEngineeringMutationFamily;
  readonly original: string;
  readonly replacement: string;
  readonly projection: DiagnosticsAdversarialProjectionInput;
}
const admission = admitExtractionSchema({
  schemaId: "diagnostics_engineering_mutation",
  schemaVersion: "1",
  schema: {
    type: "object",
    description: "One selected statement.",
    additionalProperties: false,
    required: ["statement"],
    properties: {
      statement: {
        type: "string",
        description: "Exact statement bytes decoded as text.",
        minLength: 1,
        maxLength: 2000,
      },
    },
  },
});
if (!admission.admitted || !admission.schema) throw new Error("ENGINEERING_MUTATION_SCHEMA");
const schema = admission.schema;

/** Executes derived engineering inputs against the same immutable selected evidence. */
export function runDiagnosticsEngineeringMutations(input: readonly DiagnosticsEngineeringMutation[]) {
  const records = input.map((item) => {
    const { projection } = item,
      e = projection.testCase.evidence[0];
    if (!e) throw new Error("ENGINEERING_MUTATION_EVIDENCE_REQUIRED");
    // Reuse the existing strict receipt/capture/projection/digest admission checks.
    const admitted = verifyDiagnosticsAdversarialProjection(projection);
    const selection = resolveEvidenceSelector(
      {
        captureId: e.captureId,
        representationArtifactId: e.projectionArtifactId,
        representationDigest: e.projectionDigest as `sha256:${string}`,
        selector: e.selector,
        content: projection.content,
      },
      [projectionSelectorResolver],
    );
    if (!selection || selection.resolution.status !== "resolved")
      throw new Error("ENGINEERING_MUTATION_SELECTION_REQUIRED");
    const selected = new TextDecoder("utf-8", { fatal: true }).decode(selection.selectedContent);
    const binding = {
      family: item.family,
      caseId: projection.testCase.caseId,
      sourceArtifact: projection.receipt.sourceArtifact,
      projectionArtifact: projection.receipt.projectionArtifact,
      transformationArtifact: projection.receipt.transformationArtifact,
      selector: e.selector,
      selectedContentDigest: e.selectedContentDigest,
    };
    if (!item.original || !item.replacement || item.original === item.replacement || !selected.includes(item.original))
      return {
        ...binding,
        availability: "unavailable" as const,
        reason: "distinct_replacement_and_selected_literal_required",
      };
    const verify = (candidate: string, selectedDigest: `sha256:${string}`) =>
      verifyExtractionFields({
        schema,
        candidate: { statement: candidate },
        fields: [{ path: "/statement", comparison: "exact" }],
        evidence: [
          {
            path: "/statement",
            captureId: e.captureId,
            representationArtifactId: e.projectionArtifactId,
            representationDigest: e.projectionDigest as `sha256:${string}`,
            selector: e.selector,
            expectedSelectedContentDigest: selectedDigest,
          },
        ],
        representations: [
          {
            captureId: e.captureId,
            artifactId: e.projectionArtifactId,
            digest: e.projectionDigest as `sha256:${string}`,
            content: projection.content,
          },
        ],
        selectorResolvers: [projectionSelectorResolver],
      });
    const mutated = selected.replace(item.original, item.replacement);
    const original = verify(selected, e.selectedContentDigest as `sha256:${string}`);
    const changed =
      item.family === "citations"
        ? verify(selected, sha256Digest(`corrupted:${e.selectedContentDigest}`))
        : verify(mutated, e.selectedContentDigest as `sha256:${string}`);
    return {
      ...binding,
      availability: original.valid && admitted.exactSource.valid ? ("measured" as const) : ("unavailable" as const),
      mutationKind: item.family === "citations" ? "selected_digest_tamper" : "literal_replacement",
      originalLiteral: item.original,
      replacementLiteral: item.replacement,
      originalCandidateDigest: sha256Digest(selected),
      mutatedCandidateDigest: sha256Digest(item.family === "citations" ? selected : mutated),
      mutatedSelectedContentDigest:
        item.family === "citations" ? sha256Digest(`corrupted:${e.selectedContentDigest}`) : e.selectedContentDigest,
      original,
      mutated: changed,
      degradedMechanically: original.valid && !changed.valid,
    };
  });
  return {
    schemaVersion: "diagnostics-engineering-mutations.v1" as const,
    records,
    labelBoundary: "engineering_expectations_only" as const,
    providerDispatches: 0,
    limitations: [
      "Mechanical field and citation-digest checks only; no semantic verdict, human-label quality, or complete named semantic mutation acceptance.",
    ],
  };
}
