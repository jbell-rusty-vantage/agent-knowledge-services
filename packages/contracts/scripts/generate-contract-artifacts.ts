import {
  VerificationExtractionFieldEvidenceResultSchema,
  ApplyProviderReconciliationRequestSchema,
  VerificationProviderReconciliationResourceSchema,
} from "../src/index.js";
import {
  PromotionSelectionSchema,
  PromotionSelectionAuthoritySchema,
  PromotionProposalInputSchema,
} from "../src/promotion-selection.js";
import {
  SelectedCandidateIndexInputSchema,
  SelectedCandidateEvaluationInputSchema,
  SelectedSpacePublicationInputSchema,
} from "../src/vector-store.js";
import { ContentLinkIntentSchema } from "../src/content-links.js";
import { RetrievalCitationReplaySchema } from "../src/retrieval.js";
import { VerificationProfileCaptureAcceptedSchema } from "../src/index.js";
import { ParseArtifactRequestSchema, VerificationParseArtifactResultSchema } from "../src/index.js";
import { VerificationCaptureTerminalResourceSchema } from "../src/index.js";
import { VerificationProviderReconciliationSchema } from "../src/index.js";
import { ExtractStructuredDataRequestSchema, VerificationStructuredExtractionResourceSchema } from "../src/index.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  VerificationBenchmarkOperationResultSchema,
  RunBenchmarkRequestSchema,
  VerificationBenchmarkExperimentDefinitionSchema,
  VerificationBenchmarkPublicationManifestSchema,
} from "../src/index.js";
import {
  VerificationBenchmarkComparisonProfileSchema,
  VerificationBenchmarkComparisonPublicationSchema,
  VerificationBenchmarkComparisonOperationResultSchema,
  CompareBenchmarkRunsRequestSchema,
} from "../src/index.js";
import { VerificationBenchmarkComparisonResourceSchema } from "../src/index.js";
import {
  StructuredExtractionFailureCodeSchema,
  StructuredExtractionFailureLifecycleSnapshotSchema,
  StructuredExtractionProviderCallSnapshotSchema,
  StructuredExtractionPublicationLifecycleSnapshotSchema,
  VerificationStructuredExtractionExecutionSchema,
  VerificationStructuredExtractionFailureSchema,
  VerificationStructuredExtractionFailureResultSchema,
  VerificationStructuredExtractionPublicationSchema,
  VerificationStructuredExtractionResultSchema,
  VerificationStructuredExtractionRuntimeSchema,
  VerificationStructuredExtractionSourceCustodySchema,
} from "../src/index.js";
import {
  VerificationBenchmarkRunSummaryResourceSchema,
  VerificationBenchmarkRunManifestResourceSchema,
} from "../src/index.js";
import {
  A2AResultSchema,
  A2AStatusSchema,
  A2ATaskSchema,
  AcceptedOperationSchema,
  ArtifactResourceSchema,
  CaptureSourceRequestSchema,
  CallbackAcknowledgementSchema,
  CallbackEnvelopeSchema,
  CompareVerificationBenchmarkRunsInputSchema,
  DeterministicVerificationResultSchema,
  DiagnosticsBenchmarkExperimentManifestSchema,
  DiagnosticsBenchmarkProviderObservationSchema,
  DurableReceiptResourceSchema,
  EvaluationFailuresResourceSchema,
  EvaluationReportResourceSchema,
  EvidencePacketSchema,
  ExploratoryEvaluationInputSchema,
  ModelAuthoredProposalSchema,
  MutationEnvelopeSchema,
  OperationEventSchema,
  OperationStatusSchema,
  ProblemDetailsSchema,
  PromotionDecisionSchema,
  ReceiptSchema,
  RetrievalExplanationResourceSchema,
  RetrievalPlanSchema,
  RetrievalRunInputSchema,
  RetrievalRunResourceSchema,
  RunVerificationBenchmarkInputSchema,
  SemanticAssessmentRecordSchema,
  SemanticJudgeOutputSchema,
  ServiceStatusSchema,
  VerificationBenchmarkV1CandidatePoolSchema,
  VerificationBundleSchema,
  VerificationCommandSchema,
  VerificationErrorSchema,
  VerificationEventSchema,
  VerificationOperationReceiptSchema,
  VerificationPolicyDecisionSchema,
  VerificationPolicyDefinitionSchema,
  VerificationPolicyOverrideRecordSchema,
  VerificationRecordedPolicyInputsSchema,
  VerificationResultEnvelopeSchema,
  VerificationRunManifestSchema,
  VerificationSelectorSchema,
  VerificationSourceAssessmentSchema,
  VerifyBundleInputSchema,
  VerifyClaimsInputSchema,
  VerifyExtractionInputSchema,
  VerifyExtractionRequestSchema,
  ReplayRunRequestSchema,
  VerifyMetricObservationInputSchema,
  VectorStoreResourceSchema,
  VectorStoreCreateInputSchema,
  VectorStoreDocumentsInputSchema,
  VectorStoreIngestionInputSchema,
} from "../src/index.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatedRoot = resolve(packageRoot, "generated");
const schemas = {
  ContentLinkIntent: ContentLinkIntentSchema,
  PromotionSelection: PromotionSelectionSchema,
  PromotionProposalInput: PromotionProposalInputSchema,
  SelectedCandidateIndexInput: SelectedCandidateIndexInputSchema,
  SelectedCandidateEvaluationInput: SelectedCandidateEvaluationInputSchema,
  SelectedSpacePublicationInput: SelectedSpacePublicationInputSchema,
  PromotionSelectionAuthority: PromotionSelectionAuthoritySchema,
  VerificationExtractionFieldEvidenceResult: VerificationExtractionFieldEvidenceResultSchema,
  ParseArtifactRequest: ParseArtifactRequestSchema,
  VerificationParseArtifactResult: VerificationParseArtifactResultSchema,
  ApplyProviderReconciliationRequest: ApplyProviderReconciliationRequestSchema,
  VerificationProviderReconciliationResource: VerificationProviderReconciliationResourceSchema,
  VerificationProviderReconciliation: VerificationProviderReconciliationSchema,
  ExtractStructuredDataRequest: ExtractStructuredDataRequestSchema,
  VerificationStructuredExtractionResource: VerificationStructuredExtractionResourceSchema,
  VerificationBenchmarkExperimentDefinition: VerificationBenchmarkExperimentDefinitionSchema,
  A2ATask: A2ATaskSchema,
  A2AStatus: A2AStatusSchema,
  A2AResult: A2AResultSchema,
  CallbackEnvelope: CallbackEnvelopeSchema,
  CallbackAcknowledgement: CallbackAcknowledgementSchema,
  ModelAuthoredProposal: ModelAuthoredProposalSchema,
  PromotionDecision: PromotionDecisionSchema,
  DeterministicReceipt: ReceiptSchema,
  OperationEvent: OperationEventSchema,
  RetrievalPlan: RetrievalPlanSchema,
  EvidencePacket: EvidencePacketSchema,
  ArtifactResource: ArtifactResourceSchema,
  DurableReceiptResource: DurableReceiptResourceSchema,
  VectorStoreResource: VectorStoreResourceSchema,
  VectorStoreCreateInput: VectorStoreCreateInputSchema,
  VectorStoreDocumentsInput: VectorStoreDocumentsInputSchema,
  VectorStoreIngestionInput: VectorStoreIngestionInputSchema,
  RetrievalRunResource: RetrievalRunResourceSchema,
  RetrievalExplanationResource: RetrievalExplanationResourceSchema,
  EvaluationReportResource: EvaluationReportResourceSchema,
  EvaluationFailuresResource: EvaluationFailuresResourceSchema,
  AcceptedOperation: AcceptedOperationSchema,
  MutationEnvelope: MutationEnvelopeSchema,
  OperationStatus: OperationStatusSchema,
  ProblemDetails: ProblemDetailsSchema,
  ServiceStatus: ServiceStatusSchema,
  RetrievalRunInput: RetrievalRunInputSchema,
  RetrievalCitationReplay: RetrievalCitationReplaySchema,
  ExploratoryEvaluationInput: ExploratoryEvaluationInputSchema,
  VerificationSelector: VerificationSelectorSchema,
  VerificationBundle: VerificationBundleSchema,
  VerifyBundleInput: VerifyBundleInputSchema,
  VerifyExtractionInput: VerifyExtractionInputSchema,
  VerifyClaimsInput: VerifyClaimsInputSchema,
  VerifyMetricObservationInput: VerifyMetricObservationInputSchema,
  VerificationCommand: VerificationCommandSchema,
  VerificationOperationReceipt: VerificationOperationReceiptSchema,
  VerificationEvent: VerificationEventSchema,
  VerificationError: VerificationErrorSchema,
  DeterministicVerificationResult: DeterministicVerificationResultSchema,
  SemanticJudgeOutput: SemanticJudgeOutputSchema,
  SemanticAssessmentRecord: SemanticAssessmentRecordSchema,
  VerificationSourceAssessment: VerificationSourceAssessmentSchema,
  VerificationPolicyDefinition: VerificationPolicyDefinitionSchema,
  VerificationRecordedPolicyInputs: VerificationRecordedPolicyInputsSchema,
  VerificationPolicyDecision: VerificationPolicyDecisionSchema,
  VerificationPolicyOverrideRecord: VerificationPolicyOverrideRecordSchema,
  VerificationRunManifest: VerificationRunManifestSchema,
  VerificationBenchmarkPublicationManifest: VerificationBenchmarkPublicationManifestSchema,
  VerificationBenchmarkOperationResult: VerificationBenchmarkOperationResultSchema,
  VerificationBenchmarkComparisonProfile: VerificationBenchmarkComparisonProfileSchema,
  VerificationBenchmarkComparisonPublication: VerificationBenchmarkComparisonPublicationSchema,
  VerificationBenchmarkComparisonOperationResult: VerificationBenchmarkComparisonOperationResultSchema,
  VerificationBenchmarkComparisonResource: VerificationBenchmarkComparisonResourceSchema,
  VerificationStructuredExtractionRuntime: VerificationStructuredExtractionRuntimeSchema,
  VerificationStructuredExtractionSourceCustody: VerificationStructuredExtractionSourceCustodySchema,
  VerificationStructuredExtractionExecution: VerificationStructuredExtractionExecutionSchema,
  StructuredExtractionPublicationLifecycleSnapshot: StructuredExtractionPublicationLifecycleSnapshotSchema,
  StructuredExtractionProviderCallSnapshot: StructuredExtractionProviderCallSnapshotSchema,
  VerificationStructuredExtractionPublication: VerificationStructuredExtractionPublicationSchema,
  StructuredExtractionFailureCode: StructuredExtractionFailureCodeSchema,
  StructuredExtractionFailureLifecycleSnapshot: StructuredExtractionFailureLifecycleSnapshotSchema,
  VerificationStructuredExtractionFailure: VerificationStructuredExtractionFailureSchema,
  VerificationStructuredExtractionFailureResult: VerificationStructuredExtractionFailureResultSchema,
  VerificationStructuredExtractionResult: VerificationStructuredExtractionResultSchema,
  CompareBenchmarkRunsRequest: CompareBenchmarkRunsRequestSchema,
  VerificationBenchmarkRunSummaryResource: VerificationBenchmarkRunSummaryResourceSchema,
  VerificationBenchmarkRunManifestResource: VerificationBenchmarkRunManifestResourceSchema,
  VerificationResultEnvelope: VerificationResultEnvelopeSchema,
  RunVerificationBenchmarkInput: RunVerificationBenchmarkInputSchema,
  CompareVerificationBenchmarkRunsInput: CompareVerificationBenchmarkRunsInputSchema,
  DiagnosticsBenchmarkProviderObservation: DiagnosticsBenchmarkProviderObservationSchema,
  DiagnosticsBenchmarkExperimentManifest: DiagnosticsBenchmarkExperimentManifestSchema,
  VerificationBenchmarkV1CandidatePool: VerificationBenchmarkV1CandidatePoolSchema,
  CaptureSourceRequest: CaptureSourceRequestSchema,
  VerifyExtractionRequest: VerifyExtractionRequestSchema,
  VerificationCaptureTerminalResource: VerificationCaptureTerminalResourceSchema,
  VerificationProfileCaptureAccepted: VerificationProfileCaptureAcceptedSchema,
  RunBenchmarkRequest: RunBenchmarkRequestSchema,
  ReplayRunRequest: ReplayRunRequestSchema,
} as const;

await mkdir(resolve(generatedRoot, "json-schema"), { recursive: true });
const jsonSchemas: Record<string, object> = {};
for (const [name, schema] of Object.entries(schemas)) {
  const jsonSchema = z.toJSONSchema(schema, { target: "draft-2020-12" });
  // JSON Schema's local #/$defs references are relative to the whole OpenAPI
  // document after embedding. Scope them back to their component root while
  // leaving each standalone schema self-contained.
  jsonSchemas[name] = JSON.parse(
    JSON.stringify(jsonSchema).replaceAll('"#/$defs/', `"#/components/schemas/${name}/$defs/`),
  ) as object;
  await writeFile(
    resolve(generatedRoot, "json-schema", `${name}.schema.json`),
    `${JSON.stringify(jsonSchema, null, 2)}\n`,
  );
}

type HttpMethod = "get" | "post";
type Schema = Record<string, unknown>;
interface OperationDocument {
  method: HttpMethod;
  path: string;
  fastifyRoute: string;
  operationId: string;
  summary: string;
  responseStatus?: number;
  responseSchema?: Schema;
  requestSchema?: Schema;
  public?: boolean;
  serverOwnedTenant?: boolean;
  extraParameters?: Schema[];
}
const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const accepted = ref("AcceptedOperation");
const mutation = ref("MutationEnvelope");
const operation = ref("OperationStatus");
const typedMutation = (inputSchema: string): Schema => ({
  allOf: [mutation, { type: "object", required: ["input"], properties: { input: ref(inputSchema) } }],
});
const verificationContextHeaders: Schema[] = [
  "IdempotencyKey",
  "VerificationAttemptId",
  "VerificationWorkItemId",
  "VerificationMissionId",
  "CausationId",
  "ExternalRuntime",
  "ExternalRunId",
  "ExternalRootRunId",
  "ExternalSessionId",
  "ExternalTurnId",
  "ExternalToolCallId",
].map((name) => ({ $ref: `#/components/parameters/${name}` }));
const list = (item: Schema): Schema => ({
  type: "object",
  additionalProperties: false,
  required: ["items", "nextCursor"],
  properties: { items: { type: "array", items: item }, nextCursor: { type: ["string", "null"] } },
});
const operations: OperationDocument[] = [];
const add = (document: OperationDocument) => operations.push(document);
add({
  method: "get",
  path: "/health",
  fastifyRoute: "/health",
  operationId: "getHealth",
  summary: "Process liveness",
  responseSchema: { type: "object", required: ["status"], properties: { status: { const: "ok" } } },
  public: true,
});
add({
  method: "get",
  path: "/readiness",
  fastifyRoute: "/readiness",
  operationId: "getReadiness",
  summary: "Application readiness and contract version",
  responseSchema: ref("ServiceStatus"),
  public: true,
});
add({
  method: "get",
  path: "/v1/system",
  fastifyRoute: "/v1/system",
  operationId: "getSystemStatus",
  summary: "Authenticated service status",
  responseSchema: ref("ServiceStatus"),
});
add({
  method: "post",
  path: "/v1/a2a/tasks",
  fastifyRoute: "/v1/a2a/tasks",
  operationId: "submitA2ATask",
  summary: "Admit an A2A task",
  requestSchema: ref("A2ATask"),
  responseSchema: ref("A2AStatus"),
});
add({
  method: "post",
  path: "/v1/a2a/callbacks",
  fastifyRoute: "/v1/a2a/callbacks",
  operationId: "receiveA2ACallback",
  summary: "Authenticate and record a replay-protected callback",
  requestSchema: ref("CallbackEnvelope"),
  responseSchema: ref("CallbackAcknowledgement"),
  extraParameters: [{ $ref: "#/components/parameters/CallbackSigningKeyReference" }],
});
add({
  method: "get",
  path: "/v1/operations",
  fastifyRoute: "/v1/operations",
  operationId: "listOperations",
  summary: "List tenant operations",
  responseSchema: list(operation),
});
add({
  method: "post",
  path: "/v1/operations",
  fastifyRoute: "/v1/operations",
  operationId: "submitOperation",
  summary: "Admit an explicitly typed operation",
  requestSchema: {
    type: "object",
    additionalProperties: false,
    required: ["kind", "envelope"],
    properties: { kind: { type: "string" }, envelope: mutation },
  },
  responseSchema: accepted,
});
add({
  method: "get",
  path: "/v1/operations/{operationId}",
  fastifyRoute: "/v1/operations/:id",
  operationId: "getOperation",
  summary: "Read operation status",
  responseSchema: operation,
});
add({
  method: "post",
  path: "/v1/verification/captures",
  fastifyRoute: "/v1/verification/captures",
  operationId: "captureVerificationSource",
  summary: "Register and admit a configured verification source",
  requestSchema: ref("CaptureSourceRequest"),
  responseSchema: accepted,
  extraParameters: verificationContextHeaders,
});
add({
  method: "post",
  path: "/v1/verification/artifacts:parse",
  fastifyRoute: "/v1/verification/artifacts::parse",
  operationId: "parseArtifact",
  summary: "Parse an exactly granted registered source into canonical projections",
  requestSchema: ref("ParseArtifactRequest"),
  responseSchema: accepted,
  extraParameters: verificationContextHeaders,
});
add({
  method: "post",
  path: "/v1/verification/extractions:verify",
  fastifyRoute: "/v1/verification/extractions::verify",
  operationId: "verifyExtraction",
  summary: "Verify a configured extraction against admitted evidence",
  requestSchema: ref("VerifyExtractionRequest"),
  responseSchema: accepted,
  extraParameters: verificationContextHeaders,
});
add({
  method: "get",
  path: "/v1/verification/captures/{operationId}",
  fastifyRoute: "/v1/verification/captures/:operationId",
  operationId: "getVerificationCaptureResult",
  summary: "Read authenticated compact source capture custody",
  responseSchema: ref("VerificationCaptureTerminalResource"),
});
add({
  method: "post",
  path: "/v1/verification/benchmark-capture-profiles/{profileName}/captures",
  fastifyRoute: "/v1/verification/benchmark-capture-profiles/:profileName/captures",
  operationId: "captureVerificationSourceWithProfile",
  summary: "Acquire a source using authenticated server-owned operation context",
  serverOwnedTenant: true,
  extraParameters: [{ $ref: "#/components/parameters/IdempotencyKey" }],
  requestSchema: ref("CaptureSourceRequest"),
  responseSchema: ref("VerificationProfileCaptureAccepted"),
});
add({
  method: "post",
  path: "/v1/verification/benchmarks:run",
  fastifyRoute: "/v1/verification/benchmarks::run",
  operationId: "runBenchmark",
  summary: "Run a registered frozen benchmark using recorded offline observations",
  requestSchema: ref("RunBenchmarkRequest"),
  responseSchema: accepted,
  extraParameters: verificationContextHeaders,
});
add({
  method: "post",
  path: "/v1/verification/benchmarks:compare",
  fastifyRoute: "/v1/verification/benchmarks::compare",
  operationId: "compareBenchmarkRuns",
  summary: "Compare two signed completed benchmarks using a registered comparison profile",
  requestSchema: ref("CompareBenchmarkRunsRequest"),
  responseSchema: accepted,
  extraParameters: verificationContextHeaders,
});
add({
  method: "get",
  path: "/v1/verification/extractions/{operationId}/provider-attempts/{providerAttemptId}/reconciliation",
  fastifyRoute: "/v1/verification/extractions/:operationId/provider-attempts/:providerAttemptId/reconciliation",
  operationId: "getProviderReconciliation",
  summary: "Read an authenticated applied accounting decision",
  responseSchema: ref("VerificationProviderReconciliationResource"),
});
add({
  method: "post",
  path: "/v1/verification/extractions/{operationId}/provider-attempts/{providerAttemptId}/reconciliation",
  fastifyRoute: "/v1/verification/extractions/:operationId/provider-attempts/:providerAttemptId/reconciliation",
  operationId: "applyProviderReconciliation",
  responseStatus: 200,
  summary: "Apply a signed original-attempt accounting decision",
  requestSchema: ref("ApplyProviderReconciliationRequest"),
  responseSchema: ref("VerificationProviderReconciliationResource"),
});
add({
  method: "post",
  path: "/v1/verification/extractions",
  fastifyRoute: "/v1/verification/extractions",
  operationId: "extractStructuredData",
  summary: "Produce an unverified candidate from registered source evidence",
  requestSchema: ref("ExtractStructuredDataRequest"),
  responseSchema: accepted,
  extraParameters: verificationContextHeaders,
});
add({
  method: "get",
  path: "/v1/verification/extractions/{operationId}",
  fastifyRoute: "/v1/verification/extractions/:operationId",
  operationId: "getStructuredExtraction",
  summary: "Read authenticated compact extraction custody results",
  responseSchema: ref("VerificationStructuredExtractionResource"),
});
add({
  method: "get",
  path: "/v1/verification/benchmarks/comparisons/{comparisonId}",
  fastifyRoute: "/v1/verification/benchmarks/comparisons/:comparisonId",
  operationId: "getBenchmarkComparison",
  summary: "Read signed paired engineering comparison statistics",
  responseSchema: ref("VerificationBenchmarkComparisonResource"),
});
add({
  method: "get",
  path: "/v1/verification/benchmarks/{runId}",
  fastifyRoute: "/v1/verification/benchmarks/:runId",
  operationId: "getBenchmarkRun",
  summary: "Read a completed signed benchmark summary",
  responseSchema: ref("VerificationBenchmarkRunSummaryResource"),
});
add({
  method: "get",
  path: "/v1/verification/benchmarks/{runId}/manifest",
  fastifyRoute: "/v1/verification/benchmarks/:runId/manifest",
  operationId: "getBenchmarkRunManifest",
  summary: "Read compact benchmark reproducibility metadata",
  responseSchema: ref("VerificationBenchmarkRunManifestResource"),
});
add({
  method: "post",
  path: "/v1/verification/runs/{runId}:replay",
  fastifyRoute: "/v1/verification/runs/:runId(^[^:]+)::replay",
  operationId: "replayVerificationRun",
  summary: "Replay a completed extraction from registered artifacts",
  requestSchema: ref("ReplayRunRequest"),
  responseSchema: accepted,
  extraParameters: verificationContextHeaders,
});
add({
  method: "get",
  path: "/v1/verification/operations/{operationId}",
  fastifyRoute: "/v1/verification/operations/:id",
  operationId: "getVerificationOperation",
  summary: "Read a verification operation",
  responseSchema: operation,
});
add({
  method: "get",
  path: "/v1/operations/{operationId}/events",
  fastifyRoute: "/v1/operations/:id/events",
  operationId: "listOperationEvents",
  summary: "Read ordered operation events",
  responseSchema: list(ref("OperationEvent")),
  extraParameters: [{ $ref: "#/components/parameters/AfterSequence" }],
});
for (const action of ["cancel", "retry", "reconcile"] as const)
  add({
    method: "post",
    path: `/v1/operations/{operationId}:${action}`,
    fastifyRoute: "/v1/operations/:target",
    operationId: `${action}Operation`,
    summary: `${action[0]!.toUpperCase()}${action.slice(1)} an operation`,
    requestSchema: mutation,
    responseSchema: operation,
  });
add({
  method: "post",
  path: "/v1/retrieval-plans:validate",
  fastifyRoute: "/v1/retrieval-plans:validate",
  operationId: "validateRetrievalPlan",
  summary: "Validate a retrieval plan without executing it",
  requestSchema: {
    oneOf: [ref("RetrievalPlan"), { type: "object", required: ["plan"], properties: { plan: ref("RetrievalPlan") } }],
  },
  responseStatus: 200,
  responseSchema: ref("RetrievalPlan"),
});
add({
  method: "post",
  path: "/v1/retrieval-runs",
  fastifyRoute: "/v1/retrieval-runs",
  operationId: "createRetrievalRun",
  summary: "Execute and durably record canonical retrieval",
  requestSchema: {
    allOf: [
      mutation,
      {
        type: "object",
        required: ["input", "expectedVersions"],
        properties: {
          input: ref("RetrievalRunInput"),
          expectedVersions: { type: "object", required: ["retrieval"], properties: { retrieval: { const: "v1" } } },
        },
      },
    ],
  },
  responseSchema: accepted,
});
add({
  method: "get",
  path: "/v1/retrieval-runs",
  fastifyRoute: "/v1/retrieval-runs",
  operationId: "listRetrievalRuns",
  summary: "List canonical tenant retrieval runs",
  responseSchema: list(ref("RetrievalRunResource")),
});

const collections = [
  "vector-stores",
  "captures",
  "documents",
  "document-versions",
  "representations",
  "promotion-proposals",
  "promotion-decisions",
  "embedding-runs",
  "space-publications",
  "eval-datasets",
  "experiments",
  "eval-runs",
  "reviews",
  "review-decisions",
] as const;
for (const collection of collections) {
  const name = collection.replace(/-([a-z])/g, (_, value: string) => value.toUpperCase());
  add({
    method: "post",
    path: `/v1/${collection}`,
    fastifyRoute: `/v1/${collection}`,
    operationId: `create${name[0]!.toUpperCase()}${name.slice(1)}`,
    summary: `Admit a ${collection} operation`,
    requestSchema: collection === "vector-stores" ? typedMutation("VectorStoreCreateInput") : mutation,
    responseSchema: accepted,
  });
  add({
    method: "get",
    path: `/v1/${collection}`,
    fastifyRoute: `/v1/${collection}`,
    operationId: `list${name[0]!.toUpperCase()}${name.slice(1)}`,
    summary: `List tenant ${collection} operations`,
    responseSchema: list(operation),
  });
}
const mutations: readonly [string, string, string][] = [
  ["/v1/transformations", "/v1/transformations", "createTransformation"],
  ["/v1/chunk-previews", "/v1/chunk-previews", "createChunkPreview"],
  ["/v1/chunk-comparisons", "/v1/chunk-comparisons", "createChunkComparison"],
  ["/v1/chunk-sets", "/v1/chunk-sets", "createChunkSet"],
];
for (const [path, fastifyRoute, operationId] of mutations)
  add({
    method: "post",
    path,
    fastifyRoute,
    operationId,
    summary: "Admit a bounded knowledge mutation",
    requestSchema: mutation,
    responseSchema: accepted,
  });
add({
  method: "post",
  path: "/v1/vector-stores/{vectorStoreId}/documents",
  fastifyRoute: "/v1/vector-stores/:id/documents",
  operationId: "attachVectorStoreDocuments",
  summary: "Attach canonical documents to a vector store",
  requestSchema: typedMutation("VectorStoreDocumentsInput"),
  responseSchema: accepted,
});
add({
  method: "post",
  path: "/v1/vector-stores/{vectorStoreId}/ingestion-jobs",
  fastifyRoute: "/v1/vector-stores/:id/ingestion-jobs",
  operationId: "createVectorStoreIngestionJob",
  summary: "Verify the bounded preparation, embedding, and publication chain",
  requestSchema: typedMutation("VectorStoreIngestionInput"),
  responseSchema: accepted,
});
for (const action of ["discover", "resolve"] as const)
  add({
    method: "post",
    path: `/v1/sources:${action}`,
    fastifyRoute: "/v1/:sourceAction",
    operationId: `${action}Sources`,
    summary: `${action} source candidates`,
    requestSchema: mutation,
    responseSchema: accepted,
  });
const resourceActions: readonly [string, string, string][] = [
  ["vector-stores", "search", "vectorStore"],
  ["vector-stores", "evaluate", "vectorStore"],
  ["captures", "inspect", "capture"],
  ["captures", "compare", "capture"],
  ["captures", "vet", "capture"],
  ["representations", "inspect", "representation"],
  ["representations", "compare", "representation"],
  ["representations", "decide", "representation"],
  ["chunk-sets", "inspect", "chunkSet"],
  ["space-publications", "verify", "spacePublication"],
  ["space-publications", "rollback", "spacePublication"],
];
for (const [resource, action, prefix] of resourceActions)
  add({
    method: "post",
    path: `/v1/${resource}/{resourceId}:${action}`,
    fastifyRoute: `/v1/${resource}/:target`,
    operationId: `${action}${prefix[0]!.toUpperCase()}${prefix.slice(1)}`,
    summary: `${action} a ${resource} resource`,
    requestSchema: mutation,
    responseSchema: accepted,
  });
add({
  method: "post",
  path: "/v1/demo/evaluations",
  fastifyRoute: "/v1/demo/evaluations",
  operationId: "runExploratoryEvaluation",
  summary: "Run the bounded three-bundle exploratory evaluation",
  requestSchema: { allOf: [mutation, { type: "object", properties: { input: ref("ExploratoryEvaluationInput") } }] },
  responseSchema: accepted,
});
const resourceReads: readonly [string, string, string, string][] = [
  ["/v1/vector-stores/{vectorStoreId}", "/v1/vector-stores/:id", "getVectorStore", "VectorStoreResource"],
  ["/v1/evidence-packets/{packetId}", "/v1/evidence-packets/:id", "getEvidencePacket", "EvidencePacket"],
  [
    "/v1/evidence-packets/{packetId}/citations",
    "/v1/evidence-packets/:id/citations",
    "replayEvidencePacketCitations",
    "RetrievalCitationReplay",
  ],
  ["/v1/retrieval-runs/{runId}", "/v1/retrieval-runs/:id", "getRetrievalRun", "RetrievalRunResource"],
  [
    "/v1/retrieval-runs/{runId}/explanation",
    "/v1/retrieval-runs/:id/explanation",
    "getRetrievalExplanation",
    "RetrievalExplanationResource",
  ],
  ["/v1/eval-runs/{runId}/report", "/v1/eval-runs/:id/report", "getEvaluationReport", "EvaluationReportResource"],
  [
    "/v1/eval-runs/{runId}/failures",
    "/v1/eval-runs/:id/failures",
    "getEvaluationFailures",
    "EvaluationFailuresResource",
  ],
  ["/v1/artifacts/{artifactId}", "/v1/artifacts/:id", "getArtifact", "ArtifactResource"],
  ["/v1/receipts/{receiptId}", "/v1/receipts/:id", "getReceipt", "DurableReceiptResource"],
];
for (const [path, fastifyRoute, operationId, schema] of resourceReads)
  add({
    method: "get",
    path,
    fastifyRoute,
    operationId,
    summary: "Read an immutable tenant-scoped resource",
    responseSchema: ref(schema),
  });
add({
  method: "get",
  path: "/v1/vector-stores/{vectorStoreId}/operations/{operationId}",
  fastifyRoute: "/v1/vector-stores/:id/operations/:operationId",
  operationId: "getVectorStoreOperation",
  summary: "Read an operation scoped to a vector store",
  responseSchema: operation,
});
add({
  method: "get",
  path: "/v1/chunking-procedures",
  fastifyRoute: "/v1/chunking-procedures",
  operationId: "listChunkingProcedures",
  summary: "List admitted chunking procedures",
  responseSchema: list({ type: "object" }),
});

const paths: Record<string, Partial<Record<HttpMethod, Schema>>> = {};
for (const item of operations) {
  const pathParameters = [...item.path.matchAll(/\{([^}]+)\}/g)].map((match) => ({
    in: "path",
    name: match[1],
    required: true,
    schema:
      match[1] === "profileName"
        ? { type: "string", pattern: "^[a-z][a-z0-9-]{0,63}$" }
        : { type: "string", format: "uuid" },
  }));
  const parameters = item.public
    ? pathParameters
    : [
        ...(item.serverOwnedTenant ? [] : [{ $ref: "#/components/parameters/TenantId" }]),
        { $ref: "#/components/parameters/CorrelationId" },
        ...pathParameters,
        ...(item.extraParameters ?? []),
      ];
  const responseStatus = String(item.responseStatus ?? (item.method === "post" ? 202 : 200));
  const responses: Record<string, Schema> = {
    [responseStatus]: {
      description: item.summary,
      content: { "application/json": { schema: item.responseSchema ?? { type: "object" } } },
    },
    ...(item.public
      ? {}
      : {
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "403": { $ref: "#/components/responses/Forbidden" },
          "404": { $ref: "#/components/responses/NotFound" },
          "409": { $ref: "#/components/responses/Conflict" },
          "500": { $ref: "#/components/responses/InternalError" },
          "503": { $ref: "#/components/responses/ServiceUnavailable" },
        }),
  };
  (paths[item.path] ??= {})[item.method] = {
    operationId: item.operationId,
    summary: item.summary,
    tags: [item.path.split("/")[2] || "operations"],
    "x-fastify-route": item.fastifyRoute,
    parameters,
    ...(item.public ? { security: [] } : {}),
    ...(item.requestSchema
      ? { requestBody: { required: true, content: { "application/json": { schema: item.requestSchema } } } }
      : {}),
    responses,
  };
}
const problemResponse = (description: string): Schema => ({
  description,
  content: { "application/problem+json": { schema: ref("ProblemDetails") } },
});
const openapi = {
  openapi: "3.1.0",
  info: {
    title: "AI Engineer Knowledge Services API",
    version: "1.0.0",
    description:
      "Canonical HTTP surface. Every operation records the corresponding Fastify registration in x-fastify-route for executable route parity.",
  },
  servers: [{ url: "/" }],
  security: [{ bearerAuth: [] }],
  paths,
  components: {
    schemas: jsonSchemas,
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
    parameters: {
      TenantId: { in: "header", name: "x-tenant-id", required: true, schema: { type: "string", format: "uuid" } },
      CorrelationId: {
        in: "header",
        name: "x-correlation-id",
        required: false,
        schema: { type: "string", maxLength: 255 },
      },
      IdempotencyKey: {
        in: "header",
        name: "idempotency-key",
        required: true,
        schema: { type: "string", minLength: 8, maxLength: 255 },
      },
      VerificationAttemptId: {
        in: "header",
        name: "x-verification-attempt-id",
        required: false,
        schema: { type: "string", format: "uuid" },
      },
      VerificationWorkItemId: {
        in: "header",
        name: "x-verification-work-item-id",
        required: false,
        schema: { type: "string", format: "uuid" },
      },
      VerificationMissionId: {
        in: "header",
        name: "x-verification-mission-id",
        required: false,
        schema: { type: "string", format: "uuid" },
      },
      CausationId: {
        in: "header",
        name: "x-causation-id",
        required: false,
        schema: { type: "string", minLength: 1, maxLength: 255 },
      },
      ExternalRuntime: {
        in: "header",
        name: "x-external-runtime",
        required: false,
        schema: { enum: ["eve", "vercel_workflow", "mission_control", "other"] },
      },
      ExternalRunId: {
        in: "header",
        name: "x-external-run-id",
        required: false,
        schema: { type: "string", minLength: 1, maxLength: 255 },
      },
      ExternalRootRunId: {
        in: "header",
        name: "x-external-root-run-id",
        required: false,
        schema: { type: "string", minLength: 1, maxLength: 255 },
      },
      ExternalSessionId: {
        in: "header",
        name: "x-external-session-id",
        required: false,
        schema: { type: "string", minLength: 1, maxLength: 255 },
      },
      ExternalTurnId: {
        in: "header",
        name: "x-external-turn-id",
        required: false,
        schema: { type: "string", minLength: 1, maxLength: 255 },
      },
      ExternalToolCallId: {
        in: "header",
        name: "x-external-tool-call-id",
        required: false,
        schema: { type: "string", minLength: 1, maxLength: 255 },
      },
      CallbackSigningKeyReference: {
        in: "header",
        name: "x-knowledge-callback-signing-key-reference",
        required: true,
        schema: { type: "string", maxLength: 255 },
      },
      AfterSequence: { in: "query", name: "after", required: false, schema: { type: "integer", minimum: 0 } },
    },
    responses: {
      BadRequest: problemResponse("Invalid contract"),
      Unauthorized: problemResponse("Authentication required"),
      Forbidden: problemResponse("Authority denied"),
      NotFound: problemResponse("Resource not found"),
      Conflict: problemResponse("State or idempotency conflict"),
      InternalError: problemResponse("Internal failure"),
      ServiceUnavailable: problemResponse("Required durable dependency or capability unavailable"),
    },
  },
};
await writeFile(resolve(generatedRoot, "openapi.json"), `${JSON.stringify(openapi, null, 2)}\n`);
await writeFile(
  resolve(generatedRoot, "manifest.json"),
  `${JSON.stringify({ contractVersion: "v1", generatedFrom: "packages/contracts/src", schemas: Object.keys(schemas).sort(), openApiOperationCount: operations.length }, null, 2)}\n`,
);
