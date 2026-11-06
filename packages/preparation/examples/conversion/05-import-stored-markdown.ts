import { DeterministicTextConversionProvider } from "../../src/index.js";
import { EXAMPLE_TENANT, exampleStore, printJson } from "./helpers.js";

export async function runImportStoredMarkdownExample() {
  const store = exampleStore();
  const sourceArtifact = await store.put({
    tenantId: EXAMPLE_TENANT,
    mediaType: "text/markdown",
    bytes: new TextEncoder().encode(
      "# Firecrawl-shaped import\n\nThis markdown was already stored from a vendor receipt. Convert the sealed bytes; do not re-host the vendor MCP.",
    ),
  });
  const provider = new DeterministicTextConversionProvider(store);
  const output = await provider.convert({
    tenantId: EXAMPLE_TENANT,
    sourceArtifact,
    profile: {
      profileKey: "imported-markdown",
      version: "1.0.0",
      mediaType: "text/markdown",
      managedProcessingAllowed: false,
    },
  });
  printJson({
    importSeam: "stored-markdown-to-nodes",
    sourceDigest: sourceArtifact.digest,
    provider: `${output.providerKey}@${output.providerVersion}`,
    nodeCount: output.nodes.length,
    fidelity: output.fidelity.grade,
    mocked: false,
  });
  return { output, sourceDigest: sourceArtifact.digest };
}

if (
  import.meta.url === `file://${process.argv[1]?.replaceAll("\\", "/")}` ||
  process.argv[1]?.endsWith("05-import-stored-markdown.ts")
) {
  await runImportStoredMarkdownExample();
}
