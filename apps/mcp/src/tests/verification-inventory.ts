// Every verification mutation surface: use case, durable kind/step, CLI route, MCP tool,
// HTTP path and a strict request. Shared by the surface inventory and no-HTTP-shim tests.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const tenant = id(1);
export const version = { verificationContractVersion: "verification.v1" as const };
const ref = { artifactId: id(3), digest: `sha256:${"a".repeat(64)}` };
const captures = { captureIds: [id(4)] };
// Public inventory is independent of the adapters' switch statements. A new public
// operation must be represented here before it can claim cross-surface parity.
export const verificationMutationInventory = [
  {
    useCase: "captureSource",
    kind: "verification_capture",
    step: "register_and_admit",
    cli: ["benchmark", "capture"],
    tool: "verify_benchmark_capture",
    path: "/v1/verification/captures",
    request: {
      source: {
        mode: "register",
        sourceKind: "web_page",
        sourceId: id(5),
        contentArtifact: ref,
      },
      requestedProjectionKinds: ["html_dom"],
    },
  },
  {
    useCase: "parseArtifact",
    kind: "verification_parse_artifact",
    step: "parse_and_admit",
    cli: ["artifact", "parse"],
    tool: "verify_artifact_parse",
    path: "/v1/verification/artifacts:parse",
    request: {
      captureId: id(4),
      sourceArtifact: {
        ...ref,
        tenantId: tenant,
        mediaType: "text/html",
        byteLength: 4,
        objectKey: "tenant/object",
        createdAt: "2026-09-08T00:00:00.000Z",
        producerActivityId: "capture",
        producerVersion: "v1",
        encryptionClass: "managed",
        retentionClass: "audit",
        dataClassification: "restricted",
        parentArtifactIds: [],
      },
    },
  },
  {
    useCase: "extractStructuredData",
    kind: "verification_structured_extraction",
    step: "extract_and_register",
    cli: ["extraction", "run"],
    tool: "verify_extraction_run",
    path: "/v1/verification/extractions",
    request: {
      captureId: id(4),
      representation: ref,
      extractionSchema: ref,
      extractionProfile: "registered_default",
    },
  },
  {
    useCase: "verifyExtraction",
    kind: "verification_extraction",
    step: "verify_and_register",
    cli: ["verify", "extract"],
    tool: "verify_extract",
    path: "/v1/verification/extractions:verify",
    request: { ...captures, extractionSchema: ref, extractionOutput: ref },
  },
  {
    useCase: "runBenchmark",
    kind: "verification_benchmark",
    step: "replay_recorded_and_register",
    cli: ["benchmark", "run"],
    tool: "verify_benchmark_run",
    path: "/v1/verification/benchmarks:run",
    request: {
      dataset: ref,
      experimentDefinition: ref,
      executionMode: "offline_recorded",
    },
  },
  {
    useCase: "compareBenchmarkRuns",
    kind: "verification_benchmark_compare",
    step: "compare_registered_and_publish",
    cli: ["benchmark", "compare"],
    tool: "verify_benchmark_compare",
    path: "/v1/verification/benchmarks:compare",
    request: {
      baselineRunId: id(6),
      candidateRunId: id(7),
      comparisonProfile: "paired_default",
    },
  },
  {
    useCase: "replayRun",
    kind: "verification_replay",
    step: "hydrate_and_recompute",
    cli: ["bundle", "replay"],
    tool: "verify_bundle_replay",
    path: `/v1/verification/runs/${id(6)}:replay`,
    request: { runId: id(6), replayMode: "deterministic_only" },
  },
] as const;
