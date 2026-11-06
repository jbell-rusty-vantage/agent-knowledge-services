import type { VettedBundleInput } from "@aiengineer/knowledge-application";

type TestKit = Pick<typeof import("@aiengineer/knowledge-testkit"), "loadEmbeddingBundles">;

/**
 * Loads the allow-listed exploratory bundles for the demo evaluation route from the
 * repository fixtures. The test kit is a development dependency kept outside the API
 * bundle and imported only when the demo route runs, never when the API starts. An
 * install without it has no fixtures: the route then answers "fixture unavailable".
 */
export async function loadRepositoryDemoEvaluationBundles(
  importTestKit: () => Promise<TestKit> = () => import("@aiengineer/knowledge-testkit"),
): Promise<readonly VettedBundleInput[]> {
  let testKit: TestKit;
  try {
    testKit = await importTestKit();
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "ERR_MODULE_NOT_FOUND") return [];
    throw error;
  }
  return (await testKit.loadEmbeddingBundles()).map((item) => item.bundle);
}
