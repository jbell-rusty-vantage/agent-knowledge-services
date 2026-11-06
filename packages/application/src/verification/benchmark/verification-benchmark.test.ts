import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GatewaySemanticJudgeAdapter,
  GatewayStructuredExtractionProvider,
  gatewaySemanticConfigurationDigest,
  gatewaySemanticOutputSchemaDigest,
  gatewaySemanticPromptDigest,
  InterfazeStructuredExtractionProvider,
  type ProviderArtifactSink,
} from "@aiengineer/knowledge-verification";
import { verificationBenchmarkDigest } from "@aiengineer/knowledge-evaluation";
import {
  DiagnosticsBenchmarkExtractionOutputSchema,
  type DiagnosticsBenchmarkProviderObservation,
} from "@aiengineer/knowledge-contracts";
import {
  assertDiagnosticsExtractionWireRequest,
  composeDiagnosticsRecordedArm,
  createDiagnosticsExtractionJudgeInput,
  createDiagnosticsExtractionPrompt,
  createDiagnosticsExtractionProviderInput,
  createDiagnosticsFieldLedgerArtifact,
  diagnosticsBenchmarkArms,
  DIAGNOSTICS_EXTRACTION_OUTPUT_SCHEMA,
  loadDiagnosticsExtractionExperiment,
  verifyDiagnosticsExtractionOutput,
} from "./verification-benchmark.js";
import {
  assertDiagnosticsProviderWireRequest,
  createDiagnosticsProviderCaseInput,
  createDiagnosticsProviderJudgeInput,
  createDiagnosticsProviderPrompt,
  DIAGNOSTICS_SUPPORT_OUTPUT_SCHEMA,
  loadDiagnosticsProviderGrant,
} from "../../diagnostics/verification-diagnostics-provider-grant.js";

const repository = resolve(import.meta.dirname, "../../../../..");
const catalog = resolve(repository, "catalog/verification-benchmarks/diagnostics-companies-pilot-v3");
const catalogV1 = resolve(repository, "catalog/verification-benchmarks/diagnostics-companies-v1");
const preparation = resolve(
  repository,
  "catalog/verification-assets/50a3552cffc639a78d7789865be929baefd64d2342431e2de958e669c21f163e",
);

describe("diagnostics benchmark application", () => {
  it("constructs label-free bounded provider content and rejects oversized wire requests", async () => {
    const { dataset, authority } = await loadDiagnosticsProviderGrant(catalog);
    const input = createDiagnosticsProviderCaseInput(
      dataset.cases.find((item) => item.caseId === "tru-turnaround-about-source")!,
      authority,
    );
    expect(Object.keys(input)).toEqual(["assertion", "fragment", "sourceClass", "qualifierMetadata"]);
    expect(JSON.stringify(input)).not.toContain("literal_source_summary");
    expect(() =>
      assertDiagnosticsProviderWireRequest(dataset.cases[0]!, authority, new Uint8Array(10_001), {
        provider: "gateway",
        model: "openai/gpt-5.6-luna",
      }),
    ).toThrow("BENCHMARK_PROVIDER_WIRE_UTF8_LIMIT");
    expect(() => createDiagnosticsProviderCaseInput(dataset.cases[0]!, { ...authority })).toThrow(
      "BENCHMARK_CASE_NOT_AUTHORIZED_FOR_PROVIDER",
    );
    expect(() =>
      createDiagnosticsProviderCaseInput(
        { ...dataset.cases[0]!, assertion: `${dataset.cases[0]!.assertion} changed` },
        authority,
      ),
    ).toThrow("BENCHMARK_CASE_NOT_AUTHORIZED_FOR_PROVIDER");
  });

  it("admits all three exact provider wire profiles without network access", async () => {
    const { dataset, authority } = await loadDiagnosticsProviderGrant(catalog),
      testCase = dataset.cases.find((item) => item.caseId === "tru-turnaround-product-mutated")!;
    const prompt = createDiagnosticsProviderPrompt(testCase, authority),
      judgeInput = createDiagnosticsProviderJudgeInput(testCase, authority);
    const result = {
      support: "partial",
      qualifiers_preserved: false,
      unsupported_facets: ["start event"],
      public_rationale: "The fragment requires a lab-receipt start event.",
    };
    const sink = (policy: Parameters<typeof assertDiagnosticsProviderWireRequest>[3]): ProviderArtifactSink => ({
      assertExternalProcessingAdmission: async () => undefined,
      persistBeforeDispatch: async ({ requestBytes }) =>
        assertDiagnosticsProviderWireRequest(testCase, authority, requestBytes, policy),
      persistAfterResponse: async () => undefined,
    });
    const gatewayFetch = async () =>
      new Response(
        JSON.stringify({
          model: "openai/gpt-5.6-luna",
          choices: [{ message: { content: JSON.stringify(result) } }],
          usage: { cost: 0.000001 },
        }),
        { status: 200 },
      );
    const luna = new GatewayStructuredExtractionProvider({
      apiKey: "fake",
      artifactSink: sink({ provider: "gateway", model: "openai/gpt-5.6-luna" }),
      fetch: gatewayFetch as typeof fetch,
    });
    await expect(
      luna.extract({
        prompt,
        schemaName: "benchmark_support",
        schema: DIAGNOSTICS_SUPPORT_OUTPUT_SCHEMA,
        execution: { deadlineEpochMs: Date.now() + 5_000 },
      }),
    ).resolves.toMatchObject({ output: result });
    const semantic = {
      schemaVersion: "verification-semantic-judge.v1",
      assertionId: judgeInput.assertionId,
      verdict: "partially_supported",
      nliLabel: "neutral",
      supportingFragmentIds: [judgeInput.fragments[0]!.fragmentId],
      contradictingFragmentIds: [],
      unsupportedFacets: ["start event"],
      qualifiersPreserved: false,
      publicRationale: "The start event is missing.",
    };
    const judgeFetch = async () =>
      new Response(
        JSON.stringify({
          model: "anthropic/claude-haiku-4.5",
          choices: [{ message: { content: JSON.stringify(semantic) } }],
        }),
        { status: 200 },
      );
    const judge = new GatewaySemanticJudgeAdapter({
      apiKey: "fake",
      model: "anthropic/claude-haiku-4.5",
      identity: {
        deploymentId: "test",
        provider: "vercel-ai-gateway",
        family: "anthropic",
        model: "anthropic/claude-haiku-4.5",
        capability: "llm_evidence_rubric",
        graderVersion: "evidence-only.v1",
        promptDigest: gatewaySemanticPromptDigest,
        outputSchemaDigest: gatewaySemanticOutputSchemaDigest,
        configurationDigest: gatewaySemanticConfigurationDigest("anthropic/claude-haiku-4.5"),
      },
      artifactSink: sink({ provider: "gateway", model: "anthropic/claude-haiku-4.5" }),
      fetch: judgeFetch as typeof fetch,
    });
    await expect(judge.judge(judgeInput, { deadlineEpochMs: Date.now() + 5_000 })).resolves.toMatchObject({
      verdict: "partially_supported",
    });
    const interfazeFetch = async () =>
      new Response(
        JSON.stringify({
          model: "interfaze-beta",
          choices: [{ message: { content: JSON.stringify(result) } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        { status: 200 },
      );
    const interfaze = new InterfazeStructuredExtractionProvider({
      apiKey: "fake",
      artifactSink: sink({ provider: "interfaze", model: "interfaze-beta" }),
      fetch: interfazeFetch as typeof fetch,
    });
    await expect(
      interfaze.extract({
        prompt,
        schemaName: "benchmark_support",
        schema: DIAGNOSTICS_SUPPORT_OUTPUT_SCHEMA,
        execution: { deadlineEpochMs: Date.now() + 5_000 },
      }),
    ).resolves.toMatchObject({ output: result });
  });

  it("authenticates the v4 extraction matrix and exercises all exact wire profiles with fake fetch", async () => {
    const v4 = resolve(repository, "catalog/verification-benchmarks/diagnostics-companies-pilot-v4"),
      { dataset, experiment, authority } = await loadDiagnosticsExtractionExperiment(v4);
    expect(experiment).toMatchObject({
      maximumFreshProviderCalls: 117,
      maximumFreshReservationMicros: 2_925_000,
      repetitions: 1,
      concurrency: 1,
      automaticQualityRetries: 0,
    });
    const testCase = dataset.cases.find((item) => item.caseId === "tru-sites-source")!,
      prompt = createDiagnosticsExtractionPrompt(testCase, authority),
      judgeInput = createDiagnosticsExtractionJudgeInput(testCase, authority);
    const output = DiagnosticsBenchmarkExtractionOutputSchema.parse({
      support: "full",
      qualifiers_preserved: true,
      fields: [
        {
          fieldKey: "methylation_site_count_bound",
          status: "extracted",
          value: "1,000,000+",
          evidenceQuote: "1,000,000+",
          publicRationale: "The exact count and plus marker occur in the fragment.",
        },
      ],
      unsupported_facets: [],
      public_rationale: "The assertion preserves the stated lower-bound marker.",
    });
    const fragmentBytes = new TextEncoder().encode(testCase.evidence[0]!.excerpt),
      fragmentDigest =
        `sha256:${(await import("node:crypto")).createHash("sha256").update(fragmentBytes).digest("hex")}` as const;
    expect(
      verifyDiagnosticsExtractionOutput({
        testCase,
        authority,
        output,
        fragmentBytes,
        fragmentArtifact: {
          artifactId: "61111111-1111-4111-8111-111111111111",
          tenantId: "6d057f43-6aaf-48d9-b3ba-374169abb989",
          digest: fragmentDigest,
          mediaType: "text/plain",
          byteLength: fragmentBytes.byteLength,
          objectKey: "test",
          createdAt: "2026-09-05T08:00:00.000Z",
          producerActivityId: "test",
          producerVersion: "test",
          encryptionClass: "test",
          retentionClass: "test",
          dataClassification: "restricted",
          parentArtifactIds: [],
        },
      }),
    ).toMatchObject({ schemaValid: true, requestedFieldCount: 1, extractedFieldCount: 1, fieldMechanics: true });
    const sink = (policy: Parameters<typeof assertDiagnosticsExtractionWireRequest>[3]): ProviderArtifactSink => ({
      assertExternalProcessingAdmission: async () => undefined,
      persistBeforeDispatch: async ({ requestBytes }) =>
        assertDiagnosticsExtractionWireRequest(testCase, authority, requestBytes, policy),
      persistAfterResponse: async () => undefined,
    });
    const gatewayFetch = async () =>
      new Response(
        JSON.stringify({
          model: "openai/gpt-5.6-luna",
          choices: [{ message: { content: JSON.stringify(output) } }],
          usage: { cost: 0.000001 },
        }),
        { status: 200 },
      );
    const luna = new GatewayStructuredExtractionProvider({
      apiKey: "fake",
      artifactSink: sink({ provider: "gateway", model: "openai/gpt-5.6-luna" }),
      fetch: gatewayFetch as typeof fetch,
    });
    await expect(
      luna.extract({
        prompt,
        schemaName: "benchmark_extraction",
        schema: DIAGNOSTICS_EXTRACTION_OUTPUT_SCHEMA,
        execution: { deadlineEpochMs: Date.now() + 5_000 },
      }),
    ).resolves.toMatchObject({ output });
    const interfazeFetch = async () =>
      new Response(
        JSON.stringify({
          model: "interfaze-beta",
          choices: [{ message: { content: JSON.stringify(output) } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        { status: 200 },
      );
    const interfaze = new InterfazeStructuredExtractionProvider({
      apiKey: "fake",
      artifactSink: sink({ provider: "interfaze", model: "interfaze-beta" }),
      fetch: interfazeFetch as typeof fetch,
    });
    await expect(
      interfaze.extract({
        prompt,
        schemaName: "benchmark_extraction",
        schema: DIAGNOSTICS_EXTRACTION_OUTPUT_SCHEMA,
        execution: { deadlineEpochMs: Date.now() + 5_000 },
      }),
    ).resolves.toMatchObject({ output });
    const semantic = {
      schemaVersion: "verification-semantic-judge.v1",
      assertionId: judgeInput.assertionId,
      verdict: "directly_supported",
      nliLabel: "entailed",
      supportingFragmentIds: [judgeInput.fragments[0]!.fragmentId],
      contradictingFragmentIds: [],
      unsupportedFacets: [],
      qualifiersPreserved: true,
      publicRationale: "The exact lower-bound count is present.",
    };
    const judgeFetch = async () =>
      new Response(
        JSON.stringify({
          model: "anthropic/claude-haiku-4.5",
          choices: [{ message: { content: JSON.stringify(semantic) } }],
        }),
        { status: 200 },
      );
    const judge = new GatewaySemanticJudgeAdapter({
      apiKey: "fake",
      model: "anthropic/claude-haiku-4.5",
      identity: {
        deploymentId: "test-v4",
        provider: "vercel-ai-gateway",
        family: "anthropic",
        model: "anthropic/claude-haiku-4.5",
        capability: "llm_evidence_rubric",
        graderVersion: "evidence-only.v1",
        promptDigest: gatewaySemanticPromptDigest,
        outputSchemaDigest: gatewaySemanticOutputSchemaDigest,
        configurationDigest: gatewaySemanticConfigurationDigest("anthropic/claude-haiku-4.5"),
      },
      artifactSink: sink({ provider: "gateway", model: "anthropic/claude-haiku-4.5" }),
      fetch: judgeFetch as typeof fetch,
    });
    await expect(judge.judge(judgeInput, { deadlineEpochMs: Date.now() + 5_000 })).resolves.toMatchObject({
      verdict: "directly_supported",
    });
    expect(() =>
      createDiagnosticsExtractionPrompt(
        dataset.cases.find((item) => item.caseId === "tru-turnaround-product-mutated")!,
        authority,
      ),
    ).toThrow("BENCHMARK_EXTRACTION_CASE_NOT_AUTHORIZED");
  });

  it("keeps extraction authority plans immutable and binds repeated leaves to the supplied unique quote", async () => {
    const v4 = resolve(repository, "catalog/verification-benchmarks/diagnostics-companies-pilot-v4"),
      { dataset, experiment, authority } = await loadDiagnosticsExtractionExperiment(v4);
    const testCase = dataset.cases.find((item) => item.caseId === "tru-sites-source")!;
    const originalInput = createDiagnosticsExtractionProviderInput(testCase, authority);
    const plan = experiment.casePlan.find((item) => item.caseId === testCase.caseId)!;
    (plan as any).execution = "local_only";
    (plan.fields[0] as any).fieldKey = "mutated_private_plan";
    expect(createDiagnosticsExtractionProviderInput(testCase, authority)).toEqual(originalInput);
    expect(() => createDiagnosticsExtractionProviderInput(testCase, { ...authority })).toThrow(
      "BENCHMARK_EXTRACTION_CASE_NOT_AUTHORIZED",
    );

    const fragmentBytes = new TextEncoder().encode(testCase.evidence[0]!.excerpt);
    const fragmentDigest =
      `sha256:${(await import("node:crypto")).createHash("sha256").update(fragmentBytes).digest("hex")}` as const;
    const handle = {
      artifactId: "61111111-1111-4111-8111-111111111111",
      tenantId: "6d057f43-6aaf-48d9-b3ba-374169abb989",
      digest: fragmentDigest,
      mediaType: "text/plain",
      byteLength: fragmentBytes.byteLength,
      objectKey: "test",
      createdAt: "2026-09-05T08:00:00.000Z",
      producerActivityId: "test",
      producerVersion: "test",
      encryptionClass: "test",
      retentionClass: "test",
      dataClassification: "restricted" as const,
      parentArtifactIds: [],
    };
    const leaf = "age";
    expect(testCase.evidence[0]!.excerpt.split(leaf).length - 1).toBeGreaterThan(1);
    const repeatedOutput = DiagnosticsBenchmarkExtractionOutputSchema.parse({
      support: "full",
      qualifiers_preserved: true,
      fields: [
        {
          fieldKey: "methylation_site_count_bound",
          status: "extracted",
          value: leaf,
          evidenceQuote: "biological age",
          publicRationale: "The unique quote identifies the intended occurrence.",
        },
      ],
      unsupported_facets: [],
      public_rationale: "The field is source bound.",
    });
    expect(
      verifyDiagnosticsExtractionOutput({
        testCase,
        authority,
        output: repeatedOutput,
        fragmentBytes,
        fragmentArtifact: handle,
      }),
    ).toMatchObject({ fieldMechanics: true });
    const wrongContext = DiagnosticsBenchmarkExtractionOutputSchema.parse({
      support: "full",
      qualifiers_preserved: true,
      fields: [
        {
          fieldKey: "methylation_site_count_bound",
          status: "extracted",
          value: leaf,
          evidenceQuote: "methylation sites",
          publicRationale: "The quote omits the candidate leaf.",
        },
      ],
      unsupported_facets: [],
      public_rationale: "The field is not source bound.",
    });
    expect(
      verifyDiagnosticsExtractionOutput({
        testCase,
        authority,
        output: wrongContext,
        fragmentBytes,
        fragmentArtifact: handle,
      }),
    ).toMatchObject({ fieldMechanics: false });
  });

  it("binds identical field results to candidate role and observation before CAS registration", async () => {
    const v4 = resolve(repository, "catalog/verification-benchmarks/diagnostics-companies-pilot-v4"),
      { dataset, authority } = await loadDiagnosticsExtractionExperiment(v4);
    const testCase = dataset.cases.find((item) => item.caseId === "tru-sites-source")!,
      fragmentBytes = new TextEncoder().encode(testCase.evidence[0]!.excerpt);
    const fragmentDigest =
      `sha256:${(await import("node:crypto")).createHash("sha256").update(fragmentBytes).digest("hex")}` as const;
    const handle = {
      artifactId: "61111111-1111-4111-8111-111111111111",
      tenantId: "6d057f43-6aaf-48d9-b3ba-374169abb989",
      digest: fragmentDigest,
      mediaType: "text/plain",
      byteLength: fragmentBytes.byteLength,
      objectKey: "test",
      createdAt: "2026-09-05T08:00:00.000Z",
      producerActivityId: "test",
      producerVersion: "test",
      encryptionClass: "test",
      retentionClass: "test",
      dataClassification: "restricted" as const,
      parentArtifactIds: [],
    };
    const output = DiagnosticsBenchmarkExtractionOutputSchema.parse({
      support: "full",
      qualifiers_preserved: true,
      fields: [
        {
          fieldKey: "methylation_site_count_bound",
          status: "extracted",
          value: "1,000,000+",
          evidenceQuote: "1,000,000+",
          publicRationale: "Exact leaf.",
        },
      ],
      unsupported_facets: [],
      public_rationale: "Exact extraction output.",
    });
    const fieldResult = verifyDiagnosticsExtractionOutput({
      testCase,
      authority,
      output,
      fragmentBytes,
      fragmentArtifact: handle,
    });
    const common = {
      runIdentityDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const,
      caseDigest: testCase.caseDigest as `sha256:${string}`,
      fieldResult,
    };
    const luna = createDiagnosticsFieldLedgerArtifact({
      ...common,
      role: "luna_extractor",
      observationArtifactId: "71111111-1111-4111-8111-111111111111",
    });
    const interfaze = createDiagnosticsFieldLedgerArtifact({
      ...common,
      role: "interfaze_extractor",
      observationArtifactId: "81111111-1111-4111-8111-111111111111",
    });
    expect(verificationBenchmarkDigest(luna)).not.toBe(verificationBenchmarkDigest(interfaze));
    expect(luna).toMatchObject({
      role: "luna_extractor",
      observationArtifactId: "71111111-1111-4111-8111-111111111111",
      fieldResult,
    });
    expect(interfaze).toMatchObject({
      role: "interfaze_extractor",
      observationArtifactId: "81111111-1111-4111-8111-111111111111",
      fieldResult,
    });
  });

  it("composes extraction outputs with candidate-specific field mechanics", async () => {
    const v4 = resolve(repository, "catalog/verification-benchmarks/diagnostics-companies-pilot-v4"),
      { dataset } = await loadDiagnosticsExtractionExperiment(v4);
    const testCase = dataset.cases.find((item) => item.caseId === "tru-sites-source")!;
    const digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
    const output = {
      support: "full" as const,
      qualifiers_preserved: true,
      fields: [
        {
          fieldKey: "methylation_site_count_bound",
          status: "extracted" as const,
          value: "1,000,000+",
          evidenceQuote: "1,000,000+",
          publicRationale: "Exact leaf.",
        },
      ],
      unsupported_facets: [],
      public_rationale: "Exact extraction output.",
    };
    const observation = (role: "luna_extractor" | "interfaze_extractor"): DiagnosticsBenchmarkProviderObservation => {
      const material = {
        schemaVersion: "verification-benchmark-provider-observation.v1" as const,
        caseId: testCase.caseId,
        caseDigest: testCase.caseDigest,
        role,
        provider: role === "luna_extractor" ? ("gateway" as const) : ("interfaze" as const),
        model: role === "luna_extractor" ? ("openai/gpt-5.6-luna" as const) : ("interfaze-beta" as const),
        requestDigest: digest,
        rawResponseDigest: digest,
        envelopeDigest: digest,
        output,
        promptTokens: 1,
        completionTokens: 1,
        actualCostMicros: role === "luna_extractor" ? 1 : null,
        reservationCostMicros: role === "luna_extractor" ? 5_000 : 50_000,
        latencyMs: 1,
        costState: role === "luna_extractor" ? ("actual" as const) : ("unknown_dispatched" as const),
        runDisposition: "fresh_in_run" as const,
        capturedAt: "2026-09-05T08:20:00.000Z",
        custody: {
          state: "registered" as const,
          sourceReceiptDigest: digest,
          recoveryInventoryDigest: null,
          recoveryWrapperArtifactId: null,
        },
      };
      return { ...material, observationDigest: verificationBenchmarkDigest(material) };
    };
    const observations = [observation("luna_extractor"), observation("interfaze_extractor")];
    const mechanics = {
      locatorValid: true,
      fieldMechanics: false,
      fieldMechanicsByRole: { luna_extractor: true, interfaze_extractor: false },
    };
    const baseline = composeDiagnosticsRecordedArm({
      arm: diagnosticsBenchmarkArms().find((item) => item.strategy === "baseline")!,
      testCase,
      mechanics,
      observations,
    });
    const interfaze = composeDiagnosticsRecordedArm({
      arm: diagnosticsBenchmarkArms().find((item) => item.strategy === "interfaze")!,
      testCase,
      mechanics,
      observations,
    });
    expect(baseline.execution).toMatchObject({
      schemaValid: true,
      fieldMechanics: true,
      support: "full",
      failureClass: "none",
    });
    expect(interfaze.execution).toMatchObject({
      schemaValid: true,
      fieldMechanics: false,
      support: "full",
      policy: "review",
      failureClass: "none",
    });
  });

  it("replays the three preserved smoke outputs into the four declared arms without a provider call", async () => {
    const { dataset } = await loadDiagnosticsProviderGrant(catalog),
      testCase = dataset.cases.find((item) => item.caseId === "tru-turnaround-product-mutated")!;
    const common = {
      schemaVersion: "verification-benchmark-provider-observation.v1" as const,
      caseId: testCase.caseId,
      caseDigest: testCase.caseDigest,
      capturedAt: "2026-09-05T06:55:00.000Z",
      runDisposition: "recorded_exact_reuse" as const,
      latencyMs: null,
      custody: {
        state: "recovered_bytes_original_registration_lost" as const,
        sourceReceiptDigest: "sha256:b37b7785529a24e8c95e5ae85f281dcdd40b83dbda0e1cd8ce3dee93f0a8f7eb",
        recoveryInventoryDigest: "sha256:7613ef8cb3802294f7c3175fd16af711bdd9cc2cd981020063263a3ce288601f",
        recoveryWrapperArtifactId: null,
      },
    };
    const seal = (
      material: Omit<DiagnosticsBenchmarkProviderObservation, "observationDigest">,
    ): DiagnosticsBenchmarkProviderObservation => ({
      ...material,
      observationDigest: verificationBenchmarkDigest(material),
    });
    const observations = [
      seal({
        ...common,
        role: "luna_extractor",
        provider: "gateway",
        model: "openai/gpt-5.6-luna",
        requestDigest: "sha256:667dcad756c151bb38f1be9c6ed6a3cbbd8b53546b5f0ec330055d77770c7020",
        rawResponseDigest: "sha256:ae34397e67679522cf7b2d0a8871dbb774146715af19fc0801ba9f568154b8da",
        envelopeDigest: "sha256:ecd4cbe03bbb602837348f80f307121b2c6088cae7424f3944a75c2f0e263d82",
        output: {
          support: "partial",
          qualifiers_preserved: false,
          unsupported_facets: [
            "The timing starts when the lab receives the sample, not when the customer orders the kit.",
          ],
          public_rationale:
            "The fragment says the report will be ready within 3–4 weeks after the lab receives the sample, not after the customer orders the kit.",
        },
        promptTokens: 261,
        completionTokens: 147,
        actualCostMicros: 229,
        reservationCostMicros: 5_000,
        costState: "actual",
      }),
      seal({
        ...common,
        role: "haiku_judge",
        provider: "gateway",
        model: "anthropic/claude-haiku-4.5",
        requestDigest: "sha256:cbe7514c914602a644ad75b079d76990a4a8371c84845232a1e0e6d5112e29bd",
        rawResponseDigest: "sha256:0269e8df958c6dd603d3055b47d34f64ccc44ca0a0e47ea9141330395e327712",
        envelopeDigest: "sha256:1dfb4b63adf1a4f1ef3189b92de7b98a86a49044805ad7174cc4ba66406b23b2",
        output: {
          schemaVersion: "verification-semantic-judge.v1",
          assertionId: "sha256:b9edb4496ca1d588b0f20732f1a3e2e32a475772ec93336fa753cd8f3dea2239",
          verdict: "not_supported",
          nliLabel: "neutral",
          supportingFragmentIds: [],
          contradictingFragmentIds: [],
          unsupportedFacets: ["timing measured from customer order rather than lab receipt"],
          qualifiersPreserved: true,
          publicRationale: "The assertion uses order time while the fragment uses lab receipt time.",
        },
        promptTokens: 1001,
        completionTokens: 226,
        actualCostMicros: 2_131,
        reservationCostMicros: 20_000,
        costState: "actual",
      }),
      seal({
        ...common,
        role: "interfaze_extractor",
        provider: "interfaze",
        model: "interfaze-beta",
        requestDigest: "sha256:ff78f9ca130eea9e25ebf41873c202567b5b5f5f4ff788bbc7518de4d80a3d21",
        rawResponseDigest: "sha256:f131e4211999d931658a304f632e6075b4d172837fd50e74ea3408662b8e4c3c",
        envelopeDigest: "sha256:e7db4ccded43c7c22ea369525fde574679632eb74e3d71c29afd45b2cc82f1e5",
        output: {
          support: "none",
          qualifiers_preserved: false,
          unsupported_facets: ["The start events differ."],
          public_rationale: "The stated timing starts at different events.",
        },
        promptTokens: 3627,
        completionTokens: 350,
        actualCostMicros: null,
        reservationCostMicros: 50_000,
        costState: "unknown_dispatched",
      }),
    ] satisfies DiagnosticsBenchmarkProviderObservation[];
    const decisions = Object.fromEntries(
      diagnosticsBenchmarkArms().map((arm) => [
        arm.armId,
        composeDiagnosticsRecordedArm({
          arm,
          testCase,
          mechanics: { locatorValid: true, fieldMechanics: true },
          observations,
        }),
      ]),
    );
    expect(decisions.baseline?.execution).toMatchObject({ support: "partial", policy: "review", failureClass: "none" });
    expect(decisions.interfaze?.execution).toMatchObject({ support: "none", policy: "review", failureClass: "none" });
    expect(decisions.cascade).toMatchObject({ disagreement: true, execution: { support: "none", policy: "abstain" } });
    expect(decisions.cascade?.reasonCodes).toEqual(
      expect.arrayContaining([
        "MATERIAL_QUALIFIER_NOT_PRESERVED",
        "SOURCE_AUTHORITY_UNASSESSED",
        "QUALIFIER_FLAG_DISAGREEMENT",
      ]),
    );
    expect(decisions["consensus-abstention"]).toMatchObject({
      disagreement: true,
      execution: { support: "not_applicable", policy: "abstain" },
    });
    expect(decisions["consensus-abstention"]?.reasonCodes).toEqual(
      expect.arrayContaining([
        "MATERIAL_QUALIFIER_NOT_PRESERVED",
        "SOURCE_AUTHORITY_UNASSESSED",
        "PROVIDER_DISAGREEMENT",
      ]),
    );
    expect(
      Object.values(decisions)
        .flatMap((item) => item.execution.callAttributions)
        .every((item) => item.cacheDisposition === "exact_cache_shared" && item.reservationCostMicros === 0),
    ).toBe(true);
    expect(
      Object.values(decisions)
        .flatMap((item) => item.execution.callAttributions)
        .filter((item) => item.provider === "interfaze")
        .every((item) => item.costState === "unknown_dispatched" && item.actualCostMicros === null),
    ).toBe(true);
    expect(() =>
      composeDiagnosticsRecordedArm({
        arm: diagnosticsBenchmarkArms()[0]!,
        testCase,
        mechanics: { locatorValid: true, fieldMechanics: true },
        observations: [
          {
            ...observations[0]!,
            rawResponseDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          },
        ],
      }),
    ).toThrow("BENCHMARK_PROVIDER_OBSERVATION_BINDING_INVALID");
  });

  it("keeps field, qualifier, and authority gates monotonic under full recorded support", async () => {
    const { dataset } = await loadDiagnosticsProviderGrant(catalog),
      testCase = dataset.cases.find((item) => item.evidence[0]?.sourceClass === "publication")!;
    const digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
    const observation = (qualifiersPreserved: boolean): DiagnosticsBenchmarkProviderObservation => {
      const material = {
        schemaVersion: "verification-benchmark-provider-observation.v1" as const,
        caseId: testCase.caseId,
        caseDigest: testCase.caseDigest,
        role: "luna_extractor" as const,
        provider: "gateway" as const,
        model: "openai/gpt-5.6-luna" as const,
        requestDigest: digest,
        rawResponseDigest: digest,
        envelopeDigest: digest,
        output: {
          support: "full" as const,
          qualifiers_preserved: qualifiersPreserved,
          unsupported_facets: qualifiersPreserved ? [] : ["material qualifier omitted"],
          public_rationale: "Synthetic gate regression without a provider call.",
        },
        promptTokens: 1,
        completionTokens: 1,
        actualCostMicros: 1,
        reservationCostMicros: 5_000,
        latencyMs: 1,
        costState: "actual" as const,
        runDisposition: "fresh_in_run" as const,
        capturedAt: "2026-09-05T07:50:00.000Z",
        custody: {
          state: "registered" as const,
          sourceReceiptDigest: digest,
          recoveryInventoryDigest: null,
          recoveryWrapperArtifactId: null,
        },
      };
      return { ...material, observationDigest: verificationBenchmarkDigest(material) };
    };
    const baseline = diagnosticsBenchmarkArms().find((arm) => arm.strategy === "baseline")!;
    const failedFields = composeDiagnosticsRecordedArm({
      arm: baseline,
      testCase,
      mechanics: { locatorValid: true, fieldMechanics: false },
      observations: [observation(true)],
    });
    const missingQualifier = composeDiagnosticsRecordedArm({
      arm: baseline,
      testCase,
      mechanics: { locatorValid: true, fieldMechanics: true },
      observations: [observation(false)],
    });
    const unassessedAuthority = composeDiagnosticsRecordedArm({
      arm: baseline,
      testCase,
      mechanics: { locatorValid: true, fieldMechanics: true },
      observations: [observation(true)],
    });
    expect(failedFields).toMatchObject({
      execution: { policy: "review", fieldMechanics: false, authority: "insufficient" },
      reasonCodes: ["FIELD_MECHANICS_FAILED", "SOURCE_AUTHORITY_UNASSESSED"],
    });
    expect(missingQualifier).toMatchObject({
      execution: { policy: "review", authority: "insufficient" },
      reasonCodes: ["MATERIAL_QUALIFIER_NOT_PRESERVED", "SOURCE_AUTHORITY_UNASSESSED"],
    });
    expect(unassessedAuthority).toMatchObject({
      execution: { policy: "review", authority: "insufficient" },
      reasonCodes: ["SOURCE_AUTHORITY_UNASSESSED"],
    });
  });
});
