import { createSourceLocator } from "@aiengineer/knowledge-preparation";
import type { EvidenceSupport } from "../../src/index.js";

export const id = (digit: number) => `00000000-0000-4000-8000-${String(digit).padStart(12, "0")}`;

/**
 * Evidence quoted from a stored representation, located with `createSourceLocator`
 * directly rather than through `@aiengineer/knowledge-preparation` — see the
 * README for why conversion stays out of these examples.
 */
export function evidenceFor(
  locatorId: string,
  representationId: string,
  nodeId: string,
  text: string,
): EvidenceSupport {
  return { locatorId, locator: createSourceLocator(representationId, nodeId, text), quotedText: text };
}

export function printJson(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
