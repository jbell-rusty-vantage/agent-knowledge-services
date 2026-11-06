import { ExactHttpAcquisitionAdapter } from "../src/index.js";
import { examplePolicy, exampleRequest, exampleStore, printJson, publicResolver } from "./helpers.js";

export async function runHttpAcquireExample() {
  const store = exampleStore();
  const puts: string[] = [];
  const artifacts = {
    put: async (input: Parameters<typeof store.put>[0]) => {
      puts.push(input.mediaType);
      return store.put(input);
    },
    get: store.get.bind(store),
  };
  const adapter = new ExactHttpAcquisitionAdapter(
    artifacts,
    examplePolicy,
    publicResolver,
    async () =>
      new Response("# Durable agents\n", {
        status: 200,
        headers: {
          "content-type": "text/markdown",
          "set-cookie": "secret",
          "x-api-key": "also-secret",
        },
      }),
  );
  const plan = await adapter.plan(exampleRequest({ kind: "http", url: "https://example.com/durable-agents" }));
  const result = await adapter.execute({ ...plan, admissionId: "example-http" });
  const verification = await adapter.verify(result);
  printJson({
    adapterKey: result.captureMethod,
    artifactCount: result.artifacts.length,
    digest: result.contentDigests[0],
    verification,
    headers: result.observations.find((item) => item.key === "headers")?.value,
    mocked: true,
  });
  return { result, verification, puts };
}

if (
  import.meta.url === `file://${process.argv[1]?.replaceAll("\\", "/")}` ||
  process.argv[1]?.endsWith("01-http-acquire.ts")
) {
  await runHttpAcquireExample();
}
