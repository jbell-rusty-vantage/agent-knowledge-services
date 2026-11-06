import {
  DiagnosticsBenchmarkExtractionOutputSchema,
  SemanticJudgeOutputSchema,
  type VerificationBenchmarkCase,
} from "@aiengineer/knowledge-contracts";
import {
  GatewaySemanticJudgeAdapter,
  GatewayStructuredExtractionProvider,
  InterfazeStructuredExtractionProvider,
  ProviderFailure,
  gatewaySemanticConfigurationDigest,
  gatewaySemanticOutputSchemaDigest,
  gatewaySemanticPromptDigest,
  sha256Digest,
  type ProviderArtifactSink,
} from "@aiengineer/knowledge-verification";
import {
  assertDiagnosticsExtractionWireRequest,
  createDiagnosticsExtractionJudgeInput,
  createDiagnosticsExtractionPrompt,
  createDiagnosticsExtractionProviderInput,
  DIAGNOSTICS_EXTRACTION_OUTPUT_SCHEMA,
  type DiagnosticsExtractionAuthority,
} from "./verification-benchmark.js";

/** Replays the real adapter using a memory-only response. No key, network or persistence port is accepted. */
export async function replayDiagnosticsCapturedResponse(input: {
  readonly testCase: VerificationBenchmarkCase;
  readonly authority: DiagnosticsExtractionAuthority;
  readonly role: "luna_extractor" | "interfaze_extractor" | "haiku_judge";
  readonly rawResponseBytes: Uint8Array;
  readonly httpStatus: number;
}) {
  createDiagnosticsExtractionProviderInput(input.testCase, input.authority);
  if (
    !Number.isInteger(input.httpStatus) ||
    input.httpStatus < 200 ||
    input.httpStatus > 599 ||
    input.rawResponseBytes.byteLength > 160_000
  )
    throw new Error("BENCHMARK_CAPTURED_RESPONSE_INPUT_INVALID");
  const raw = input.rawResponseBytes.slice();
  const model =
    input.role === "luna_extractor"
      ? "openai/gpt-5.6-luna"
      : input.role === "interfaze_extractor"
        ? "interfaze-beta"
        : "anthropic/claude-haiku-4.5";
  const provider = input.role === "interfaze_extractor" ? "interfaze" : "gateway";
  let memoryFetches = 0;
  const retainedPrecontext: { bytes: Uint8Array | null } = { bytes: null };
  const artifactSink: ProviderArtifactSink = {
    async assertExternalProcessingAdmission() {},
    async persistBeforeDispatch({ requestBytes }) {
      assertDiagnosticsExtractionWireRequest(input.testCase, input.authority, requestBytes, { provider, model });
    },
    async persistAfterResponse(response) {
      if (sha256Digest(response.rawResponseBytes) !== sha256Digest(raw))
        throw new Error("BENCHMARK_CAPTURED_RESPONSE_BYTES_CHANGED");
      if (response.precontextBytes) retainedPrecontext.bytes = response.precontextBytes.slice();
    },
  };
  const memoryFetch: typeof fetch = async () => {
    memoryFetches++;
    if (memoryFetches !== 1) throw new Error("BENCHMARK_CAPTURED_RESPONSE_RETRY_FORBIDDEN");
    // WHATWG Response disallows bodies for these statuses. Actual HTTP cannot carry one either.
    const noBody = [204, 205, 304].includes(input.httpStatus);
    if (noBody && raw.byteLength) throw new Error("BENCHMARK_CAPTURED_RESPONSE_STATUS_BODY_INVALID");
    return new Response(noBody ? null : new Uint8Array(raw), { status: input.httpStatus });
  };
  const execution = { deadlineEpochMs: Date.now() + 10_000 };
  try {
    let output;
    if (input.role === "haiku_judge") {
      const adapter = new GatewaySemanticJudgeAdapter({
        apiKey: "offline-replay-only",
        model: "anthropic/claude-haiku-4.5",
        identity: {
          deploymentId: "diagnostics-offline-response-replay",
          provider: "vercel-ai-gateway",
          family: "anthropic",
          model: "anthropic/claude-haiku-4.5",
          capability: "llm_evidence_rubric",
          graderVersion: "evidence-only.v1",
          promptDigest: gatewaySemanticPromptDigest,
          outputSchemaDigest: gatewaySemanticOutputSchemaDigest,
          configurationDigest: gatewaySemanticConfigurationDigest("anthropic/claude-haiku-4.5"),
        },
        artifactSink,
        fetch: memoryFetch,
      });
      output = SemanticJudgeOutputSchema.parse(
        await adapter.judge(createDiagnosticsExtractionJudgeInput(input.testCase, input.authority), execution),
      );
    } else {
      const options = { apiKey: "offline-replay-only", artifactSink, fetch: memoryFetch };
      const adapter =
        input.role === "interfaze_extractor"
          ? new InterfazeStructuredExtractionProvider(options)
          : new GatewayStructuredExtractionProvider(options);
      const result = await adapter.extract({
        prompt: createDiagnosticsExtractionPrompt(input.testCase, input.authority),
        schemaName: "benchmark_extraction",
        schema: DIAGNOSTICS_EXTRACTION_OUTPUT_SCHEMA,
        execution,
      });
      const parsed = DiagnosticsBenchmarkExtractionOutputSchema.safeParse(result.output);
      if (!parsed.success)
        return {
          accepted: false as const,
          failureCode: "PROVIDER_RESPONSE_SCHEMA_INVALID" as const,
          memoryFetches,
          externalRequests: 0 as const,
        };
      output = parsed.data;
    }
    return {
      accepted: true as const,
      output,
      precontextBytes: retainedPrecontext.bytes?.slice() ?? null,
      memoryFetches,
      externalRequests: 0 as const,
    };
  } catch (error) {
    if (error instanceof ProviderFailure)
      return { accepted: false as const, failureCode: error.code, memoryFetches, externalRequests: 0 as const };
    throw new Error("BENCHMARK_CAPTURED_RESPONSE_REPLAY_INTERNAL_FAILURE");
  }
}
