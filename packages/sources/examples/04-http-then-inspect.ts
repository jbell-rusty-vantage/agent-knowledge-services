import { ExactHttpAcquisitionAdapter, observeSealedCapture, readSealedCapture } from "../src/index.js";
import { examplePolicy, exampleRequest, exampleStore, printJson, publicResolver } from "./helpers.js";

export async function runHttpThenInspectExample() {
  const store = exampleStore();
  const adapter = new ExactHttpAcquisitionAdapter(
    store,
    examplePolicy,
    publicResolver,
    async () =>
      new Response('Public guidance. token = "super-secret-value"', {
        headers: { "content-type": "text/plain" },
      }),
  );
  const plan = await adapter.plan(exampleRequest({ kind: "http", url: "https://example.com/guide" }));
  const result = await adapter.execute({ ...plan, admissionId: "example-sequence" });
  const digest = result.artifacts[0]!.digest;
  const bytes = await store.get(result.plan.request.tenantId, digest);
  if (!bytes) throw new Error("SEALED_BYTES_MISSING");
  const excerpt = readSealedCapture({
    bytes,
    digest,
    length: 20,
  });
  const observation = observeSealedCapture({
    bytes,
    digest,
    acquireObservations: result.observations,
  });
  printJson({
    sequence: ["plan", "execute", "verify", "read", "observe"],
    digest,
    excerpt,
    secretClassObserved: observation.findings.some((item) => item.dimension === "secret_class" && item.secretClass),
    mockedFetch: true,
  });
  return { result, excerpt, observation };
}

if (process.argv[1]?.includes("04-http-then-inspect")) await runHttpThenInspectExample();
