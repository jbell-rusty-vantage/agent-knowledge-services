import { SourceLocatorSchema, type DocumentNode, type SourceLocator } from "@aiengineer/knowledge-contracts";
import { deepFreeze, sha256Digest } from "@aiengineer/knowledge-core";
import type { StructuralBlock } from "../types.js";

// A locator carries the digest of the text it points at, so a later reader can
// prove the quote still matches the sealed node before citing it.
export function createSourceLocator(
  representationId: string,
  nodeId: string,
  text: string,
  locator: StructuralBlock["locator"] = {},
): SourceLocator {
  return SourceLocatorSchema.parse({
    ...locator,
    representationId,
    nodeId,
    quoteDigest: sha256Digest(text),
  });
}

// Only the fields a block actually supplied enter the node digest; an absent
// page and an explicit `undefined` must hash the same.
export function locatorDigestValue(locator: StructuralBlock["locator"]): Record<string, string | number | string[]> {
  if (locator === undefined) return {};
  return {
    ...(locator.page === undefined ? {} : { page: locator.page }),
    ...(locator.sectionPath === undefined ? {} : { sectionPath: [...locator.sectionPath] }),
    ...(locator.startOffset === undefined ? {} : { startOffset: locator.startOffset }),
    ...(locator.endOffset === undefined ? {} : { endOffset: locator.endOffset }),
    ...(locator.startTimeMs === undefined ? {} : { startTimeMs: locator.startTimeMs }),
    ...(locator.endTimeMs === undefined ? {} : { endTimeMs: locator.endTimeMs }),
    ...(locator.domPath === undefined ? {} : { domPath: locator.domPath }),
    ...(locator.symbol === undefined ? {} : { symbol: locator.symbol }),
  };
}

export function reconstructNodeSpan(node: DocumentNode, startOffset = 0, endOffset = node.text.length): string {
  if (startOffset < 0 || endOffset <= startOffset || endOffset > node.text.length) {
    throw new RangeError(`Invalid node span ${startOffset}:${endOffset} for ${node.id}`);
  }
  return node.text.slice(startOffset, endOffset);
}

export function verifyNodeLocators(nodes: readonly DocumentNode[]): readonly string[] {
  const issues: string[] = [];
  for (const node of nodes) {
    if (node.locator.representationId !== node.representationId) issues.push(`${node.id}: representation mismatch`);
    if (node.locator.nodeId !== node.id) issues.push(`${node.id}: node mismatch`);
    if (node.locator.quoteDigest !== sha256Digest(node.text)) issues.push(`${node.id}: quote digest mismatch`);
    const end = node.locator.endOffset;
    if (end !== undefined && end > node.text.length) issues.push(`${node.id}: offset exceeds text`);
  }
  return deepFreeze(issues);
}
