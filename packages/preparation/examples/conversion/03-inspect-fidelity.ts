import { DeterministicTextConversionProvider } from "../../src/index.js";
import { EXAMPLE_TENANT, exampleStore, printJson } from "./helpers.js";

export async function runInspectFidelityExample() {
  const store = exampleStore();
  const sourceArtifact = await store.put({
    tenantId: EXAMPLE_TENANT,
    mediaType: "text/markdown",
    bytes: new TextEncoder().encode(
      "# Heading\n\nA short public paragraph about planning.\n\n```ts\nconst ready = true;\n```",
    ),
  });
  const provider = new DeterministicTextConversionProvider(store);
  const output = await provider.convert({
    tenantId: EXAMPLE_TENANT,
    sourceArtifact,
    profile: {
      profileKey: "markdown",
      version: "1.0.0",
      mediaType: "text/markdown",
      managedProcessingAllowed: false,
    },
  });
  printJson({
    provider: `${output.providerKey}@${output.providerVersion}`,
    fidelity: output.fidelity.grade,
    checks: output.fidelity.checks,
    headings: output.metrics.headings,
    codeBlocks: output.metrics.codeBlocks,
    nodeKinds: output.nodes.map((node) => node.kind),
    mocked: false,
  });
  return { output };
}

if (
  import.meta.url === `file://${process.argv[1]?.replaceAll("\\", "/")}` ||
  process.argv[1]?.endsWith("03-inspect-fidelity.ts")
) {
  await runInspectFidelityExample();
}
