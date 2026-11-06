import { ExactHttpAcquisitionAdapter } from "../src/index.js";
import { examplePolicy, exampleRequest, exampleStore, printJson } from "./helpers.js";

export async function runHttpPolicyFailureExample() {
  let putCount = 0;
  const store = exampleStore();
  const artifacts = {
    put: async (input: Parameters<typeof store.put>[0]) => {
      putCount += 1;
      return store.put(input);
    },
    get: store.get.bind(store),
  };
  const adapter = new ExactHttpAcquisitionAdapter(artifacts, examplePolicy, { resolve: async () => ["10.0.0.4"] });
  let denied = "";
  try {
    await adapter.plan(exampleRequest({ kind: "http", url: "https://internal.example/private" }));
  } catch (error) {
    denied = error instanceof Error ? error.message : String(error);
  }
  printJson({
    error: denied,
    storePuts: putCount,
    mockedDns: true,
  });
  return { denied, putCount };
}

if (process.argv[1]?.includes("06-http-policy-failure")) await runHttpPolicyFailureExample();
