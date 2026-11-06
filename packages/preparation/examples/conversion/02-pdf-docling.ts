import { ConversionRouter } from "../../src/index.js";
import { countingProvider, exampleStore, pdfRequest, printJson, stubOutput, unusedTextProvider } from "./helpers.js";

export async function runPdfDoclingExample() {
  const store = exampleStore();
  const calls: string[] = [];
  const router = new ConversionRouter(
    unusedTextProvider(),
    countingProvider("docling-serve", calls, async () => stubOutput("docling-serve")),
    countingProvider("unstructured-transform", calls, async () => {
      throw new Error("unused");
    }),
  );
  const routed = await router.convertWithReceipt(await pdfRequest(store, false));
  printJson({
    selectedProviderKey: routed.receipt.selectedProviderKey,
    candidateRoute: routed.receipt.candidateRoute,
    fallbackUsed: routed.receipt.fallbackUsed,
    unstructuredInvoked: calls.includes("unstructured-transform"),
    mocked: true,
  });
  return { routed, calls };
}

if (
  import.meta.url === `file://${process.argv[1]?.replaceAll("\\", "/")}` ||
  process.argv[1]?.endsWith("02-pdf-docling.ts")
) {
  await runPdfDoclingExample();
}
