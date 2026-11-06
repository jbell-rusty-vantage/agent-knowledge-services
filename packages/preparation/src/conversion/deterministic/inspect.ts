import { LOW_COVERAGE_THRESHOLD, REPEATED_BLOCK_REVIEW_RATIO } from "../constants.js";
import type {
  ConversionMetrics,
  ConversionNode,
  ConversionNodeKind,
  FidelityFinding,
  FidelityGrade,
  FidelityReport,
} from "../types.js";

const FIDELITY_CHECKS = [
  "content_digest",
  "stable_nodes",
  "span_bounds",
  "locator_resolvability",
  "encoding_scan",
  "duplicate_scan",
] as const;

const REPLACEMENT_CHARACTER = "\uFFFD";
const FULL_COVERAGE = 1;
const FULL_LOCATOR_RESOLVABILITY = 1;
const ALTERNATE_CONVERSION = "alternate_conversion";

function countKinds(nodes: readonly ConversionNode[], kinds: readonly ConversionNodeKind[]): number {
  return nodes.filter((node) => kinds.includes(node.kind)).length;
}

function repeatedBlockCount(nodes: readonly ConversionNode[]): number {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    counts.set(node.contentDigest, (counts.get(node.contentDigest) ?? 0) + 1);
  }
  return nodes.filter((node) => (counts.get(node.contentDigest) ?? 0) > 1).length;
}

function hasResolvableLocator(node: ConversionNode): boolean {
  return node.locator.startOffset !== undefined && node.locator.endOffset !== undefined;
}

function conversionMetrics(input: string, output: string, nodes: readonly ConversionNode[]): ConversionMetrics {
  const nonRoot = nodes.slice(1);
  const repeated = repeatedBlockCount(nonRoot);
  return {
    inputCharacters: input.length,
    outputCharacters: output.length,
    characterCoverage: input.length === 0 ? FULL_COVERAGE : Math.min(1, output.length / input.length),
    headings: countKinds(nonRoot, ["heading"]),
    tables: countKinds(nonRoot, ["table"]),
    figures: countKinds(nonRoot, ["figure", "image"]),
    codeBlocks: countKinds(nonRoot, ["code_block"]),
    citations: countKinds(nonRoot, ["citation"]),
    emptyNodes: nonRoot.filter((node) => !node.text.trim()).length,
    repeatedBlockRatio: nonRoot.length ? repeated / nonRoot.length : 0,
    locatorResolvability: nonRoot.length
      ? nonRoot.filter(hasResolvableLocator).length / nonRoot.length
      : FULL_LOCATOR_RESOLVABILITY,
    encodingAnomalies: (output.match(new RegExp(REPLACEMENT_CHARACTER, "g")) ?? []).length,
  };
}

function fidelityFindings(metrics: ConversionMetrics): FidelityFinding[] {
  const findings: FidelityFinding[] = [];
  if (metrics.characterCoverage < LOW_COVERAGE_THRESHOLD) {
    findings.push({
      disposition: ALTERNATE_CONVERSION,
      nodeIds: [],
      impact: "low text coverage",
      allowedAction: "route to admitted fallback",
    });
  }
  if (metrics.encodingAnomalies) {
    findings.push({
      disposition: "repair",
      nodeIds: [],
      impact: "encoding replacement characters",
      allowedAction: "retry pinned decoder",
    });
  }
  if (metrics.repeatedBlockRatio > REPEATED_BLOCK_REVIEW_RATIO) {
    findings.push({
      disposition: "review",
      nodeIds: [],
      impact: "probable boilerplate",
      allowedAction: "inspect duplicate blocks",
    });
  }
  return findings;
}

function fidelityGrade(findings: readonly FidelityFinding[]): FidelityGrade {
  if (findings.some((finding) => finding.disposition === ALTERNATE_CONVERSION)) {
    return "low";
  }
  return findings.length > 0 ? "medium" : "high";
}

export function inspectConversion(
  input: string,
  output: string,
  nodes: readonly ConversionNode[],
): { metrics: ConversionMetrics; fidelity: FidelityReport } {
  const metrics = conversionMetrics(input, output, nodes);
  const findings = fidelityFindings(metrics);
  return {
    metrics,
    fidelity: {
      grade: fidelityGrade(findings),
      metrics,
      checks: [...FIDELITY_CHECKS],
      findings,
    },
  };
}

export function requiresAlternateConversion(fidelity: FidelityReport | undefined): boolean {
  return Boolean(fidelity?.findings.some((finding) => finding.disposition === ALTERNATE_CONVERSION));
}
