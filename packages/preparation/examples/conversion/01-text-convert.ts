import { ConversionRouter, DeterministicTextConversionProvider } from "../../src/index.js";
import { EXAMPLE_TENANT, countingProvider, exampleStore, printJson } from "./helpers.js";

export async function runTextConvertExample() {
  const store = exampleStore();
  const sourceArtifact = await store.put({
    tenantId: EXAMPLE_TENANT,
    mediaType: "text/markdown",
    bytes: new TextEncoder().encode("# Durable agents\n\nPlan, act, and evaluate."),
  });
  const calls: string[] = [];
  const router = new ConversionRouter(
    new DeterministicTextConversionProvider(store),
    countingProvider("docling-serve", calls, async () => {
      throw new Error("unused");
    }),
    countingProvider("unstructured-transform", calls, async () => {
      throw new Error("unused");
    }),
  );
  const routed = await router.convertWithReceipt({
    tenantId: EXAMPLE_TENANT,
    sourceArtifact,
    profile: {
      profileKey: "markdown",
      version: "1.0.0",
      mediaType: "text/markdown",
      managedProcessingAllowed: true,
    },
  });
  printJson({
    selectedProviderKey: routed.receipt.selectedProviderKey,
    candidateRoute: routed.receipt.candidateRoute,
    fallbackUsed: routed.receipt.fallbackUsed,
    fidelity: routed.output.fidelity.grade,
    nodeKinds: routed.output.nodes.map((node) => node.kind),
    binaryCalls: calls,
    mocked: true,
  });
  return { routed, calls };
}

if (
  import.meta.url === `file://${process.argv[1]?.replaceAll("\\", "/")}` ||
  process.argv[1]?.endsWith("01-text-convert.ts")
) {
  await runTextConvertExample();
}
