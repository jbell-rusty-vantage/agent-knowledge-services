import { chunkDocument, defaultChunkProfileRegistry, reconstructChunk } from "../../src/index.js";
import { paperWithoutTables, printJson } from "./fixtures.js";

/**
 * chunkDocument only slices a sealed tree: every span replays to the chunk
 * sourceText from the nodes it came from, repeated boilerplate is omitted rather
 * than embedded, and the same nodes and profile give the same outputDigest.
 */
export function chunkAndReconstructExample() {
  const profile = defaultChunkProfileRegistry.get("heading-sections-v1");
  const first = chunkDocument(paperWithoutTables.nodes, profile);
  const second = chunkDocument(paperWithoutTables.nodes, profile);
  return {
    profile: `${profile.name}@${profile.version}`,
    chunks: first.chunks.map(({ ordinal, sourceText, contextualPrefix, sourceTokenCount, spans }) => ({
      ordinal,
      sourceText,
      contextualPrefix,
      sourceTokenCount,
      spanCount: spans.length,
    })),
    omittedNodeCount: first.omittedNodeIds.length,
    everySpanReconstructs: first.chunks.every(
      (chunk) => reconstructChunk(chunk, paperWithoutTables.nodes) === chunk.sourceText,
    ),
    qa: first.qa,
    outputDigest: first.outputDigest,
    deterministic: first.outputDigest === second.outputDigest,
  };
}

if (process.argv[1]?.includes("02-chunk-and-reconstruct")) printJson(chunkAndReconstructExample());
