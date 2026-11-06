import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  loadDiagnosticsExtractionExperiment,
  createDiagnosticsExtractionJudgeInput,
} from "./verification-benchmark.js";
import { replayDiagnosticsCapturedResponse } from "./verification-benchmark-response-replay.js";

describe("captured diagnostics adapter replay", () => {
  it("replays all three profiles and their envelope failures without global fetch", async () => {
    const { dataset, authority } = await loadDiagnosticsExtractionExperiment(
      resolve(import.meta.dirname, "../../../../../catalog/verification-benchmarks/diagnostics-companies-pilot-v4"),
    );
    const testCase = dataset.cases.find((item) => item.caseId === "tru-sites-source")!;
    const judge = createDiagnosticsExtractionJudgeInput(testCase, authority);
    const extracted = {
      support: "full",
      qualifiers_preserved: true,
      fields: [
        {
          fieldKey: "methylation_site_count_bound",
          status: "extracted",
          value: "1,000,000+",
          evidenceQuote: "1,000,000+",
          publicRationale: "Synthetic replay fixture.",
        },
      ],
      unsupported_facets: [],
      public_rationale: "Synthetic replay fixture.",
    };
    const semantic = {
      schemaVersion: "verification-semantic-judge.v1",
      assertionId: judge.assertionId,
      verdict: "directly_supported",
      nliLabel: "entailed",
      supportingFragmentIds: [judge.fragments[0]!.fragmentId],
      contradictingFragmentIds: [],
      unsupportedFacets: [],
      qualifiersPreserved: true,
      publicRationale: "Synthetic replay fixture.",
    };
    const globalFetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("NETWORK_FORBIDDEN"));
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    try {
      for (const role of ["luna_extractor", "interfaze_extractor", "haiku_judge"] as const) {
        const model =
          role === "luna_extractor"
            ? "openai/gpt-5.6-luna"
            : role === "interfaze_extractor"
              ? "interfaze-beta"
              : "anthropic/claude-haiku-4.5";
        const body = {
          model,
          choices: [{ message: { content: JSON.stringify(role === "haiku_judge" ? semantic : extracted) } }],
        };
        const common = { testCase, authority, role, httpStatus: 200 };
        await expect(
          replayDiagnosticsCapturedResponse({ ...common, rawResponseBytes: bytes(body) }),
        ).resolves.toMatchObject({ accepted: true, memoryFetches: 1, externalRequests: 0 });
        await expect(
          replayDiagnosticsCapturedResponse({ ...common, rawResponseBytes: bytes({ ...body, model: "wrong-model" }) }),
        ).resolves.toMatchObject({ accepted: false, failureCode: "PROVIDER_RESPONSE_INVALID" });
        await expect(
          replayDiagnosticsCapturedResponse({
            ...common,
            httpStatus: 500,
            rawResponseBytes: bytes({ error: "Synthetic HTTP error" }),
          }),
        ).resolves.toMatchObject({ accepted: false, failureCode: "PROVIDER_HTTP_FAILURE" });
        if (role === "interfaze_extractor") {
          await expect(
            replayDiagnosticsCapturedResponse({
              ...common,
              rawResponseBytes: bytes({ ...body, precontext: [{ name: "unapproved_tool", result: {} }] }),
            }),
          ).resolves.toMatchObject({ accepted: false, failureCode: "PROVIDER_RESPONSE_INVALID" });
          const retained = await replayDiagnosticsCapturedResponse({
            ...common,
            rawResponseBytes: bytes({
              ...body,
              precontext: [{ name: "ocr", result: { text: "Synthetic retained metadata" } }],
            }),
          });
          expect(retained.accepted).toBe(true);
          if (!retained.accepted || !retained.precontextBytes) throw new Error("PRECONTEXT_REPLAY_REQUIRED");
          expect(JSON.parse(new TextDecoder().decode(retained.precontextBytes))).toEqual([
            { name: "ocr", result: { text: "Synthetic retained metadata" } },
          ]);
        }
      }
      expect(globalFetch).not.toHaveBeenCalled();
    } finally {
      globalFetch.mockRestore();
    }
  });
});
