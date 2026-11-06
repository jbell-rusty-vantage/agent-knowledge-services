import { deepFreeze, sha256Digest } from "@aiengineer/knowledge-core";
import type { EvidenceSupport, EvidenceValidationResult, ProjectionInput } from "../types.js";

export function validateEvidenceSupport(input: ProjectionInput): EvidenceValidationResult {
  const issues: string[] = [];
  const evidenceById = new Map<string, EvidenceSupport>();
  for (const evidence of input.evidence) {
    if (evidenceById.has(evidence.locatorId)) {
      issues.push(`duplicate evidence locator ${evidence.locatorId}`);
    }
    evidenceById.set(evidence.locatorId, evidence);
    if (evidence.quotedText.trim().length === 0) {
      issues.push(`${evidence.locatorId}: quoted text is empty`);
    }
    if (
      evidence.locator.quoteDigest !== undefined &&
      evidence.locator.quoteDigest !== sha256Digest(evidence.quotedText)
    ) {
      issues.push(`${evidence.locatorId}: quote digest mismatch`);
    }
  }
  if (input.evidence.length === 0) {
    issues.push("at least one evidence locator is required");
  }
  if (input.space !== "source_native_sections" && input.assertions.length === 0) {
    issues.push("derived projections require supported assertions");
  }
  for (const assertion of input.assertions) {
    if (assertion.statement.trim().length === 0) {
      issues.push(`${assertion.id}: assertion is empty`);
    }
    if (assertion.supportLocatorIds.length === 0) {
      issues.push(`${assertion.id}: assertion has no support`);
    }
    for (const locatorId of assertion.supportLocatorIds) {
      if (!evidenceById.has(locatorId)) {
        issues.push(`${assertion.id}: unknown support locator ${locatorId}`);
      }
    }
  }
  if (input.space === "source_native_sections" && input.assertions.length > 0) {
    issues.push("source-native sections must remain faithful rather than carry derived assertions");
  }
  if (input.space === "source_native_sections") {
    const reconstructed = input.evidence.map(({ quotedText }) => quotedText).join("\n\n");
    if (input.sourceText !== reconstructed) {
      issues.push("source-native text does not exactly match ordered evidence text");
    }
  }
  const supportSetDigest = sha256Digest(
    JSON.stringify(
      [...evidenceById.values()]
        .map(({ locatorId, locator, quotedText }) => ({
          locatorId,
          locator,
          quoteDigest: sha256Digest(quotedText),
        }))
        .sort((a, b) => a.locatorId.localeCompare(b.locatorId)),
    ),
  );
  return deepFreeze({ valid: issues.length === 0, issues, supportSetDigest });
}
