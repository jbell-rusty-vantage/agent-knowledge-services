import { ConversionRouter } from "../../src/index.js";
import { countingProvider, exampleStore, pdfRequest, printJson, stubOutput, unusedTextProvider } from "./helpers.js";

export async function runDoclingThenUnstructuredExample() {
  const store = exampleStore();
  const calls: string[] = [];
  const router = new ConversionRouter(
    unusedTextProvider(),
    countingProvider("docling-serve", calls, async () => {
      throw new Error("PROVIDER_UNAVAILABLE:secret-must-not-escape");
    }),
    countingProvider("unstructured-transform", calls, async () => stubOutput("unstructured-transform")),
  );
  const routed = await router.convertWithReceipt(await pdfRequest(store, true));
  printJson({
    selectedProviderKey: routed.receipt.selectedProviderKey,
    candidateRoute: routed.receipt.candidateRoute,
    fallbackUsed: routed.receipt.fallbackUsed,
    attempts: routed.receipt.attempts,
    secretLeaked: JSON.stringify(routed.receipt).includes("secret-must-not-escape"),
    mocked: true,
  });
  return { routed, calls };
}

if (
  import.meta.url === `file://${process.argv[1]?.replaceAll("\\", "/")}` ||
  process.argv[1]?.endsWith("04-docling-then-unstructured.ts")
) {
  await runDoclingThenUnstructuredExample();
}
