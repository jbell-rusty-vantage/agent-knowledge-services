import { ConversionRouter, UnstructuredTransformProvider } from "../../src/index.js";
import {
  EXAMPLE_TENANT,
  countingProvider,
  exampleStore,
  pdfRequest,
  printJson,
  stubOutput,
  unusedTextProvider,
} from "./helpers.js";

export async function runManagedDeniedExample() {
  const store = exampleStore();
  let unstructuredJobs = 0;
  const paid = new UnstructuredTransformProvider(
    "1.0.0",
    {
      createJob: async () => {
        unstructuredJobs += 1;
        throw new Error("should-not-run");
      },
      getJob: async () => ({ state: "failed" }),
      downloadResult: async () => ({
        native: new Uint8Array(),
        markdown: "",
        plainText: "",
      }),
    },
    store,
  );
  const router = new ConversionRouter(
    unusedTextProvider(),
    countingProvider("docling-serve", [], async () => stubOutput("docling-serve")),
    paid,
  );
  const routed = await router.convertWithReceipt(await pdfRequest(store, false));
  const denied = await paid
    .convert({
      tenantId: EXAMPLE_TENANT,
      sourceArtifact: (await pdfRequest(store, false)).sourceArtifact,
      profile: {
        profileKey: "pdf",
        version: "1.0.0",
        mediaType: "application/pdf",
        managedProcessingAllowed: false,
      },
    })
    .then(() => undefined)
    .catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
  printJson({
    selectedProviderKey: routed.receipt.selectedProviderKey,
    candidateRoute: routed.receipt.candidateRoute,
    unstructuredJobs,
    denied,
    mocked: true,
  });
  return { routed, unstructuredJobs, denied };
}

if (
  import.meta.url === `file://${process.argv[1]?.replaceAll("\\", "/")}` ||
  process.argv[1]?.endsWith("06-managed-denied.ts")
) {
  await runManagedDeniedExample();
}
