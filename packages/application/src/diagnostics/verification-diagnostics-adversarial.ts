import type { VerificationBenchmarkCase, VerificationSelector } from "@aiengineer/knowledge-contracts";
import {
  admitExtractionSchema,
  projectionSelectorResolver,
  resolveEvidenceSelector,
  sha256Digest,
  verifyExtractionFields,
  type ExtractionFieldVerificationResult,
} from "@aiengineer/knowledge-verification";
import type { ProjectionAdmissionReceipt } from "../verification/admission/verification-admission.js";

/** Read-only deterministic observations for one already admitted frozen projection. */
export interface DiagnosticsAdversarialProjectionInput {
  readonly testCase: VerificationBenchmarkCase;
  readonly receipt: ProjectionAdmissionReceipt;
  readonly content: Uint8Array;
}

export interface DiagnosticsAdversarialMechanic {
  readonly evaluated: true;
  readonly valid: boolean;
  readonly failedCheckCodes: readonly string[];
}

export interface DiagnosticsAdversarialObservation {
  readonly caseId: string;
  readonly transforms: readonly string[];
  readonly exactSource: DiagnosticsAdversarialMechanic;
  readonly corruptedLocator:
    | (DiagnosticsAdversarialMechanic & { readonly selector: VerificationSelector })
    | { readonly evaluated: false; readonly reason: "selector_kind_not_mutatable" };
  readonly selectedDigestTamper: DiagnosticsAdversarialMechanic;
  /** The actual case assertion is compared to frozen evidence mechanically. It is not a semantic verdict. */
  readonly assertionTextReplay: DiagnosticsAdversarialMechanic;
  /** Deterministic extraction cannot infer contradiction, partial entailment, source authority, or policy. */
  readonly unsupportedSemanticPaths: readonly string[];
}

const statementSchemaAdmission = admitExtractionSchema({
  schemaId: "diagnostics_adversarial_source_statement",
  schemaVersion: "1",
  schema: {
    type: "object",
    description: "One exact frozen source selection.",
    additionalProperties: false,
    required: ["statement"],
    properties: {
      statement: { type: "string", description: "Exact selected source statement.", minLength: 1, maxLength: 2_000 },
    },
  },
});
if (!statementSchemaAdmission.admitted || !statementSchemaAdmission.schema)
  throw new Error("DIAGNOSTICS_ADVERSARIAL_SCHEMA_NOT_ADMITTED");
const statementSchema = statementSchemaAdmission.schema;

const failedCheckCodes = (result: ExtractionFieldVerificationResult) =>
  Object.freeze(
    result.checks
      .filter((check) => check.status === "failed")
      .map((check) => check.code)
      .sort(),
  );
const mechanic = (result: ExtractionFieldVerificationResult): DiagnosticsAdversarialMechanic =>
  Object.freeze({ evaluated: true, valid: result.valid, failedCheckCodes: failedCheckCodes(result) });

function corruptSelector(selector: VerificationSelector): VerificationSelector | undefined {
  if (selector.kind === "html") return { ...selector, domPath: `${selector.domPath}/999999` };
  if (selector.kind === "text_quote") return { ...selector, quote: `${selector.quote}\u0000corrupted` };
  if (selector.kind === "character_position") return { ...selector, start: selector.end, end: selector.end + 1 };
  if (selector.kind === "table") return { ...selector, row: selector.row + 10_000 };
  if (selector.kind === "bounding_box") return { ...selector, x: selector.x + selector.width + 1 };
  if (selector.kind === "media_timecode")
    return { ...selector, startMs: selector.endMs + 1, endMs: selector.endMs + 2 };
  return undefined;
}

/**
 * Re-resolves immutable frozen evidence through the real extraction verifier.
 * This creates neither source artifacts nor semantic labels; semantic paths stay explicitly unevaluated.
 */
export function verifyDiagnosticsAdversarialProjection(
  input: DiagnosticsAdversarialProjectionInput,
): DiagnosticsAdversarialObservation {
  const evidence = input.testCase.evidence[0];
  if (!evidence) throw new Error("DIAGNOSTICS_ADVERSARIAL_EVIDENCE_REQUIRED");
  const receipt = input.receipt;
  const projectionDigest = receipt.projectionArtifact.digest as `sha256:${string}`;
  const selectedDigest = evidence.selectedContentDigest as `sha256:${string}`;
  if (
    evidence.captureId !== receipt.captureId ||
    evidence.projectionArtifactId !== receipt.projectionArtifact.artifactId ||
    evidence.projectionDigest !== projectionDigest ||
    evidence.transformationArtifactId !== receipt.transformationArtifact.artifactId ||
    sha256Digest(input.content) !== projectionDigest
  )
    throw new Error("DIAGNOSTICS_ADVERSARIAL_ADMISSION_BINDING");

  const selected = resolveEvidenceSelector(
    {
      captureId: evidence.captureId,
      representationArtifactId: receipt.projectionArtifact.artifactId,
      representationDigest: projectionDigest,
      selector: evidence.selector,
      content: input.content,
    },
    [projectionSelectorResolver],
  );
  if (
    !selected ||
    selected.resolution.status !== "resolved" ||
    selected.resolution.occurrenceCount !== 1 ||
    selected.resolution.selectedContentDigest !== selectedDigest
  )
    throw new Error("DIAGNOSTICS_ADVERSARIAL_SOURCE_SELECTOR_UNRESOLVED");
  const sourceText = new TextDecoder("utf-8", { fatal: true }).decode(selected.selectedContent);

  const verify = (candidate: string, selector: VerificationSelector, digest: `sha256:${string}`) =>
    verifyExtractionFields({
      schema: statementSchema,
      candidate: { statement: candidate },
      fields: [{ path: "/statement", comparison: "normalized_text", normalizationId: "source-whitespace" }],
      normalizations: [{ id: "source-whitespace", operation: "ascii_whitespace_collapsed" }],
      evidence: [
        {
          path: "/statement",
          captureId: evidence.captureId,
          representationArtifactId: receipt.projectionArtifact.artifactId,
          representationDigest: projectionDigest,
          selector,
          expectedSelectedContentDigest: digest,
        },
      ],
      representations: [
        {
          captureId: receipt.captureId,
          artifactId: receipt.projectionArtifact.artifactId,
          digest: projectionDigest,
          content: input.content,
        },
      ],
      selectorResolvers: [projectionSelectorResolver],
    });

  const corrupt = corruptSelector(evidence.selector);
  return Object.freeze({
    caseId: input.testCase.caseId,
    transforms: Object.freeze([...input.testCase.adversarialTransforms]),
    exactSource: mechanic(verify(sourceText, evidence.selector, selectedDigest)),
    corruptedLocator:
      corrupt === undefined
        ? Object.freeze({ evaluated: false as const, reason: "selector_kind_not_mutatable" as const })
        : Object.freeze({
            ...mechanic(verify(sourceText, corrupt, selectedDigest)),
            selector: structuredClone(corrupt),
          }),
    selectedDigestTamper: mechanic(verify(sourceText, evidence.selector, `sha256:${"0".repeat(64)}`)),
    assertionTextReplay: mechanic(verify(input.testCase.assertion, evidence.selector, selectedDigest)),
    unsupportedSemanticPaths: Object.freeze([
      "contradiction_or_entailment",
      "qualifier_materiality",
      "source_authority",
      "policy_admission",
    ]),
  });
}
