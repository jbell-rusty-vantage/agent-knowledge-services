import { convertStructuralDocument, reconstructNodeSpan, verifyNodeLocators } from "../../src/index.js";
import { pageBlocks, printJson } from "./fixtures.js";

/**
 * Conversion makes the tree. Blocks become immutable nodes with content-derived
 * ids, normalized text, and a locator that carries the digest of the text it
 * points at; verifyNodeLocators then proves every locator still matches, and a
 * span reconstructs from the sealed text alone.
 */
export function buildNodesAndVerifyLocatorsExample() {
  const first = convertStructuralDocument(pageBlocks);
  const second = convertStructuralDocument(pageBlocks);
  const body = first.nodes[1]!;
  return {
    documentDigest: first.digest,
    deterministic:
      first.digest === second.digest && first.nodes.every((node, index) => node.id === second.nodes[index]?.id),
    nodes: first.nodes.map(({ id, kind, parentId, text, locator }) => ({
      id,
      kind,
      parentId,
      text,
      page: locator.page,
      quoteDigest: locator.quoteDigest,
    })),
    locatorIssues: verifyNodeLocators(first.nodes),
    frozen: first.nodes.every((node) => Object.isFrozen(node)),
    span: reconstructNodeSpan(body, 0, 7),
  };
}

if (process.argv[1]?.includes("01-build-nodes-and-verify-locators")) printJson(buildNodesAndVerifyLocatorsExample());
