import { convertStructuralDocument, reconstructNodeSpan, verifyNodeLocators } from "../../src/index.js";
import { pageBlocks, printJson } from "./fixtures.js";

/**
 * A broken tree fails as a whole, an out-of-range span is refused, and a node
 * whose text was edited after sealing is reported by verifyNodeLocators. None of
 * these produce a partial document an agent could quote from.
 */
export function rejectCycleAndInvalidSpanExample() {
  const message = (work: () => unknown) => {
    try {
      work();
      return undefined;
    } catch (error) {
      return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
  };
  const [title, body] = pageBlocks.blocks;
  const sealed = convertStructuralDocument(pageBlocks);
  const edited = { ...sealed.nodes[1]!, text: "Workers never renew a lease before each retry." };
  return {
    cycle: message(() =>
      convertStructuralDocument({ ...pageBlocks, blocks: [{ ...title!, parentKey: "body" }, body!] }),
    ),
    unknownParent: message(() =>
      convertStructuralDocument({ ...pageBlocks, blocks: [{ ...body!, parentKey: "missing" }] }),
    ),
    invalidSpan: message(() => reconstructNodeSpan(sealed.nodes[1]!, 0, 10_000)),
    emptySpan: message(() => reconstructNodeSpan(sealed.nodes[1]!, 4, 4)),
    editedNodeIssues: verifyNodeLocators([edited]),
  };
}

if (process.argv[1]?.includes("02-reject-cycle-and-invalid-span")) printJson(rejectCycleAndInvalidSpanExample());
