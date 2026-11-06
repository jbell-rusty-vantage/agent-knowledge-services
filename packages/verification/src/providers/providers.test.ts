import { describe, expect, it } from "vitest";
import { boundedResponseJson } from "./http.js";
import {
  GatewaySemanticJudgeAdapter,
  gatewaySemanticConfigurationDigest,
  gatewaySemanticOutputSchemaDigest,
  gatewaySemanticPromptDigest,
  GatewayStructuredExtractionProvider,
  InterfazeStructuredExtractionProvider,
  ProviderFailure,
} from "./index.js";

const schema = {
  type: "object",
  description: "Synthetic record fields.",
  properties: {
    vendor: { type: "string", description: "Synthetic vendor.", maxLength: 80 },
    systems: {
      type: "integer",
      description: "Synthetic system count.",
      minimum: 0,
      maximum: 100,
    },
  },
  required: ["vendor", "systems"],
  additionalProperties: false,
} as const;
const completion = (output: unknown, precontext: unknown = []) =>
  new Response(
    JSON.stringify({
      id: "provider-response",
      model: "interfaze-beta",
      choices: [{ message: { content: JSON.stringify(output) } }],
      precontext,
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
const sink = {
  async assertExternalProcessingAdmission() {},
  async persistBeforeDispatch() {},
  async persistAfterResponse() {},
};

describe("bounded provider adapters", () => {
  it("requests fixed-task JSON with an empty schema while preserving strict extraction schemas", async () => {
    const bodies: Record<string, unknown>[] = [];
    const provider = new InterfazeStructuredExtractionProvider({
      apiKey: "test",
      artifactSink: sink,
      fetch: (async (_url, init) => {
        bodies.push(JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)));
        return bodies.length === 1
          ? completion({ name: "ocr", result: { text: "synthetic" } })
          : completion({ vendor: "Example Labs", systems: 21 });
      }) as typeof fetch,
    });
    await provider.runTask({
      task: "ocr",
      prompt: "Read synthetic image.",
      inputData: {
        filename: "fixture.png",
        dataUri: "data:image/png;base64,AA==",
      },
      execution: {},
    });
    await provider.extract({
      prompt: "Extract.",
      schemaName: "synthetic_record",
      schema,
      execution: {},
    });
    expect(bodies[0]?.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "task_output", schema: {} },
    });
    expect(bodies[0]?.messages).toEqual(expect.arrayContaining([{ role: "system", content: "<task>ocr</task>" }]));
    expect(bodies[1]?.response_format).toMatchObject({
      type: "json_schema",
      json_schema: {
        name: "synthetic_record",
        strict: true,
        schema: { type: "object", additionalProperties: false },
      },
    });
  });

  it("sends Interfaze ZDR at the HTTP boundary and persists its successful HTTP status before parsing", async () => {
    const events: string[] = [];
    let observed: RequestInit | undefined;
    const provider = new InterfazeStructuredExtractionProvider({
      apiKey: "test",
      artifactSink: {
        async assertExternalProcessingAdmission() {},
        async persistBeforeDispatch(input) {
          events.push(`request:${input.requestDigest}`);
        },
        async persistAfterResponse(input) {
          events.push(
            `response:${input.httpStatus}:${input.requestDigest}:${input.rawResponseBytes.byteLength}:${input.precontextBytes?.byteLength ?? 0}`,
          );
        },
      },
      fetch: (async (_url, init) => {
        observed = init;
        return completion({ vendor: "Example Labs", systems: 21 });
      }) as typeof fetch,
    });
    const result = await provider.extract({
      prompt: "Extract only fixture fields.",
      schemaName: "synthetic_record",
      schema,
      execution: {},
    });
    expect((observed?.headers as Record<string, string>)["x-interfaze-zdr"]).toBe("true");
    expect(events).toHaveLength(2);
    expect(events[0]!.startsWith("request:")).toBe(true);
    expect(events[1]!.startsWith("response:200:")).toBe(true);
    expect(result.output).toEqual({ vendor: "Example Labs", systems: 21 });
  });

  it("admits and persists the request before the network is touched, then persists the response before interpreting it", async () => {
    const events: string[] = [];
    const provider = new InterfazeStructuredExtractionProvider({
      apiKey: "test",
      artifactSink: {
        async assertExternalProcessingAdmission() {
          events.push("admission");
        },
        async persistBeforeDispatch() {
          events.push("request");
        },
        async persistAfterResponse() {
          events.push("response");
        },
      },
      fetch: (async () => {
        events.push("fetch");
        return completion({ vendor: "Example Labs", systems: 21 });
      }) as typeof fetch,
    });
    await provider.extract({
      prompt: "Extract only fixture fields.",
      schemaName: "synthetic_record",
      schema,
      execution: {},
    });
    expect(events).toEqual(["admission", "request", "fetch", "response"]);
  });

  it("retains bounded known precontext returned with structured extraction", async () => {
    const persisted: Array<{ bytes: number; status: number | undefined }> = [];
    const provider = new InterfazeStructuredExtractionProvider({
      apiKey: "test",
      artifactSink: {
        async assertExternalProcessingAdmission() {},
        async persistBeforeDispatch() {},
        async persistAfterResponse(input) {
          persisted.push({
            bytes: input.precontextBytes?.byteLength ?? 0,
            status: input.httpStatus,
          });
        },
      },
      fetch: async () =>
        completion({ vendor: "Example Labs", systems: 21 }, [
          { name: "scraper", result: { selected: "bounded fixture" } },
        ]) as Response,
    });
    const result = await provider.extract({
      prompt: "Extract.",
      schemaName: "synthetic_record",
      schema,
      execution: {},
    });
    expect(result.precontext).toMatchObject([{ name: "scraper" }]);
    expect(persisted).toHaveLength(2);
    expect(persisted[0]).toMatchObject({ bytes: 0, status: 200 });
    expect(persisted[1]!.bytes).toBeGreaterThan(0);
    expect(persisted[1]!.status).toBe(200);
  });

  it("rejects unsupported tasks and accepts the explicit stt precontext alias only", async () => {
    const provider = new InterfazeStructuredExtractionProvider({
      apiKey: "test",
      artifactSink: sink,
      fetch: async () =>
        completion({ name: "stt", result: { text: "synthetic" } }, [
          { name: "stt", result: { text: "synthetic" } },
        ]) as Response,
    });
    await expect(
      provider.runTask({
        task: "speech_to_text",
        prompt: "Transcribe synthetic audio.",
        inputData: {
          filename: "fixture.wav",
          dataUri: "data:audio/wav;base64,AA==",
        },
        execution: {},
      }),
    ).resolves.toMatchObject({ output: { name: "stt" } });
    await expect(
      provider.runTask({
        task: "search" as never,
        prompt: "x",
        inputData: { filename: "x", dataUri: "data:text/plain;base64,eA==" },
        execution: {},
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_UNSUPPORTED_TASK" });
  });

  it("retains actual 200 status before locally rejecting a schema-invalid Gateway response", async () => {
    const statuses: number[] = [];
    const provider = new GatewayStructuredExtractionProvider({
      apiKey: "test",
      artifactSink: {
        async assertExternalProcessingAdmission() {},
        async persistBeforeDispatch() {},
        async persistAfterResponse(input) {
          statuses.push(input.httpStatus!);
        },
      },
      fetch: async () =>
        new Response(
          JSON.stringify({
            model: "openai/gpt-5.6-luna",
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    vendor: "Example Labs",
                    systems: 21,
                    extra: true,
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        ) as Response,
    });
    await expect(
      provider.extract({
        prompt: "Extract.",
        schemaName: "synthetic_record",
        schema,
        execution: {},
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_RESPONSE_SCHEMA_INVALID" });
    expect(statuses).toEqual([200]);
  });

  it("retains a non-2xx status before raising the HTTP failure", async () => {
    const statuses: number[] = [];
    const provider = new GatewayStructuredExtractionProvider({
      apiKey: "test",
      artifactSink: {
        async assertExternalProcessingAdmission() {},
        async persistBeforeDispatch() {},
        async persistAfterResponse(input) {
          statuses.push(input.httpStatus!);
        },
      },
      fetch: async () =>
        new Response(JSON.stringify({ error: "busy" }), {
          status: 503,
        }) as Response,
    });
    await expect(
      provider.extract({
        prompt: "Extract.",
        schemaName: "synthetic_record",
        schema,
        execution: {},
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_HTTP_FAILURE", retryable: true });
    expect(statuses).toEqual([503]);
  });

  it("retains raw bytes before rejecting an unknown task precontext name", async () => {
    const events: string[] = [];
    const provider = new InterfazeStructuredExtractionProvider({
      apiKey: "test",
      artifactSink: {
        async assertExternalProcessingAdmission() {},
        async persistBeforeDispatch() {
          events.push("request");
        },
        async persistAfterResponse() {
          events.push("raw");
        },
      },
      fetch: async () =>
        completion({ name: "ocr", result: { text: "synthetic" } }, [{ name: "forbidden", result: {} }]) as Response,
    });
    await expect(
      provider.runTask({
        task: "ocr",
        prompt: "Read synthetic image.",
        inputData: {
          filename: "fixture.png",
          dataUri: "data:image/png;base64,AA==",
        },
        execution: {},
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_RESPONSE_INVALID" });
    expect(events).toEqual(["request", "raw"]);
  });

  it("bounds raw response bytes before JSON parsing", async () => {
    await expect(boundedResponseJson(new Response("x".repeat(2_000)), 1_000)).rejects.toBeInstanceOf(ProviderFailure);
  });

  it("keeps Gateway semantic requests tool-free and bounded", async () => {
    let body: Record<string, unknown> | undefined;
    const adapter = new GatewaySemanticJudgeAdapter({
      apiKey: "test",
      model: "openai/gpt-5.6-luna",
      identity: {
        deploymentId: "gateway-luna",
        provider: "vercel-ai-gateway",
        family: "openai",
        model: "openai/gpt-5.6-luna",
        capability: "llm_evidence_rubric",
        graderVersion: "evidence-only.v1",
        promptDigest: gatewaySemanticPromptDigest,
        outputSchemaDigest: gatewaySemanticOutputSchemaDigest,
        configurationDigest: gatewaySemanticConfigurationDigest("openai/gpt-5.6-luna"),
      },
      artifactSink: sink,
      fetch: (async (_url, init) => {
        body = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array));
        return new Response(
          JSON.stringify({
            model: "openai/gpt-5.6-luna",
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    schemaVersion: "verification-semantic-judge.v1",
                    assertionId: "assertion",
                    verdict: "directly_supported",
                    nliLabel: "entailed",
                    supportingFragmentIds: ["fragment"],
                    contradictingFragmentIds: [],
                    unsupportedFacets: [],
                    qualifiersPreserved: true,
                    publicRationale: "Exact fixture support.",
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    });
    await expect(
      adapter.judge(
        {
          rubricVersion: "evidence-only.v1",
          assertionId: "assertion",
          proposition: "fixture",
          qualifiers: [],
          entityBindings: [],
          fragments: [{ fragmentId: "fragment", exactText: "fixture" }],
        },
        {},
      ),
    ).resolves.toMatchObject({ assertionId: "assertion" });
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
    expect(body?.messages).toBeDefined();
  });
});
