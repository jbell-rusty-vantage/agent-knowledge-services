import { describe, expect, it } from "vitest";
import { loadRepositoryDemoEvaluationBundles } from "../demo-evaluation-bundles.js";

describe("demo evaluation bundle loader", () => {
  it("loads the three allow-listed repository bundles through the test kit", async () => {
    const bundles = await loadRepositoryDemoEvaluationBundles();
    expect(bundles.map((bundle) => bundle.video_id).sort()).toEqual(["bk0TmxoZlUY", "kTnfJszFxCg", "rmvDxxNubIg"]);
  });

  it("reports no fixtures when the test kit is not installed", async () => {
    const missing = Object.assign(new Error("Cannot find package '@aiengineer/knowledge-testkit'"), {
      code: "ERR_MODULE_NOT_FOUND",
    });
    await expect(loadRepositoryDemoEvaluationBundles(() => Promise.reject(missing))).resolves.toEqual([]);
  });

  it("does not hide other test kit failures", async () => {
    await expect(
      loadRepositoryDemoEvaluationBundles(() => Promise.reject(new Error("FIXTURE_DIGEST_MISMATCH"))),
    ).rejects.toThrow("FIXTURE_DIGEST_MISMATCH");
  });
});
