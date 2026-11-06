import { PROJECTION_RESOLVER_VERSION } from "../../versions.js";
import { evidenceSelectionReporter, type EvidenceSelection, type EvidenceSelectionRequest } from "../selection.js";
import type { Range } from "./shared.js";

/**
 * Report builders for every projection resolver. Projection selections are claims that
 * `resolveEvidenceSelector` re-verifies, so they carry bytes only (see `ResolvedSelectionOutcome`).
 * Projection locators never normalize text, so every report carries `normalization: "none"`.
 */
const report = evidenceSelectionReporter(PROJECTION_RESOLVER_VERSION);

export const unresolved = report.unresolved;

export function resolvedText(
  request: EvidenceSelectionRequest,
  text: string,
  ranges: readonly Range[],
): EvidenceSelection {
  return report.resolvedText(request, text, {
    resolvedRanges: ranges,
    exposure: "bytes_only",
  });
}

export function resolvedValue(
  request: EvidenceSelectionRequest,
  value: unknown,
  ranges: readonly Range[],
): EvidenceSelection {
  return report.resolvedValue(request, value, {
    resolvedRanges: ranges,
    exposure: "bytes_only",
  });
}
