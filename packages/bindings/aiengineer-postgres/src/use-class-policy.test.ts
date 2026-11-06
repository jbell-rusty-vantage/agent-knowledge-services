import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type IngestionIntent, type UseClassPolicy, assertUseAdmissible } from "@aiengineer/knowledge-db";
import { loadUseClassRegistry, useClassPolicy } from "@aiengineer/knowledge-research-core";
import { describe, expect, it } from "vitest";

/**
 * R1 F9 with the real K08 registry (`catalog/research/use-classes.json`): research-core's `useClassPolicy` is the
 * executor's use-class policy, so the one registry decides both the research use class and native admission.
 */
const here = dirname(fileURLToPath(import.meta.url));
const registry = loadUseClassRegistry(
  JSON.parse(readFileSync(resolve(here, "../../../../catalog/research/use-classes.json"), "utf8")),
);
const policy: UseClassPolicy = useClassPolicy(registry);
const intent = (extra: Partial<IngestionIntent>) => ({ intentId: "i-1", ...extra }) as IngestionIntent;
const refusal = (candidate: IngestionIntent): string | null => {
  try {
    assertUseAdmissible(candidate, policy);
    return null;
  } catch (error) {
    return (error as { code: string }).code;
  }
};

describe("K08 use-class registry as the executor's admission policy (R1 F9)", () => {
  it("requires an exact-use binding for official and consequential uses only", () => {
    expect(refusal(intent({ declaredUse: { use: "report_publication", audience: "official" } }))).toBe(
      "REVIEW_REQUIRED",
    );
    expect(refusal(intent({ declaredUse: { use: "knowledge_ingestion.fact_assert_state", audience: "team" } }))).toBe(
      "REVIEW_REQUIRED",
    );
    expect(refusal(intent({ declaredUse: { use: "notes", audience: "draft" } }))).toBeNull();
    expect(refusal(intent({}))).toBeNull();
    expect(policy.registry.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
