import { KnowledgeJevClient } from "./jev.js";
import {
  ApplyProviderReconciliationRequestSchema,
  VerificationProviderReconciliationResourceSchema,
  type ApplyProviderReconciliationRequest,
} from "@aiengineer/knowledge-contracts";
import { VerificationProfileCaptureAcceptedSchema } from "@aiengineer/knowledge-contracts";
import {
  ExtractStructuredDataRequestSchema,
  VerificationStructuredExtractionResourceSchema,
  type ExtractStructuredDataRequest,
} from "@aiengineer/knowledge-contracts";
import { ParseArtifactRequestSchema, type ParseArtifactRequest } from "@aiengineer/knowledge-contracts";
import { VerificationCaptureTerminalResourceSchema } from "@aiengineer/knowledge-contracts";
import {
  VerificationBenchmarkComparisonResourceSchema,
  CompareBenchmarkRunsRequestSchema,
  type CompareBenchmarkRunsRequest,
  VerificationBenchmarkRunSummaryResourceSchema,
  VerificationBenchmarkRunManifestResourceSchema,
  RunBenchmarkRequestSchema,
  type RunBenchmarkRequest,
} from "@aiengineer/knowledge-contracts";
import {
  A2AStatusSchema,
  A2ATaskSchema,
  AcceptedOperationSchema,
  ArtifactResourceSchema,
  CallbackAcknowledgementSchema,
  CallbackEnvelopeSchema,
  CaptureSourceRequestSchema,
  DurableReceiptResourceSchema,
  EvaluationFailuresResourceSchema,
  EvaluationReportResourceSchema,
  EvidencePacketSchema,
  OperationStatusSchema,
  ProblemDetailsSchema,
  ReplayRunRequestSchema,
  RetrievalCitationReplaySchema,
  RetrievalExplanationResourceSchema,
  RetrievalPlanSchema,
  RetrievalRunResourceSchema,
  VectorStoreResourceSchema,
  VectorStoreCreateInputSchema,
  VectorStoreDocumentsInputSchema,
  VectorStoreIngestionInputSchema,
  VerifyExtractionRequestSchema,
  type A2ATask,
  type AcceptedOperation,
  type CallbackEnvelope,
  type CaptureSourceRequest,
  type EvidencePacket,
  type ExploratoryBundleDescriptor,
  type JsonValue,
  type OperationContext,
  type OperationKind,
  type OperationStatus,
  type ProblemDetails,
  type ReplayRunRequest,
  type RetrievalPlan,
  type VectorStoreCreateInput,
  type VectorStoreDocumentsInput,
  type VectorStoreIngestionInput,
  type VerifyExtractionRequest,
} from "@aiengineer/knowledge-contracts";
import { z } from "zod";
import { UuidSchema } from "@aiengineer/knowledge-contracts";

export class KnowledgeClientError extends Error {
  constructor(readonly problem: ProblemDetails) {
    super(problem.detail ?? problem.title);
    this.name = "KnowledgeClientError";
  }
}
export interface KnowledgeClientOptions {
  baseUrl: string;
  getAccessToken?: () => string | Promise<string>;
  fetch?: typeof globalThis.fetch;
  expectedVersions?: Readonly<Record<string, string>>;
}
export interface VerificationClientContext
  extends Pick<OperationContext, "tenantId" | "correlationId">,
    Partial<Pick<OperationContext, "attemptId" | "workItemId" | "missionId" | "causationId" | "externalExecution">> {
  readonly idempotencyKey: string;
}
const EventPageSchema = z.object({
  items: z.array(
    z
      .object({
        id: z.string(),
        operationId: z.string(),
        sequence: z.number(),
        type: z.string(),
        occurredAt: z.string(),
        payloadDigest: z.string(),
      })
      .passthrough(),
  ),
  nextCursor: z.string().nullable().optional(),
});

export class KnowledgeClient {
  readonly jev: KnowledgeJevClient;
  readonly #baseUrl: URL;
  readonly #fetch: typeof globalThis.fetch;
  readonly #getAccessToken: () => string | Promise<string>;
  readonly #expectedVersions: Readonly<Record<string, string>>;
  constructor(options: KnowledgeClientOptions) {
    this.jev = new KnowledgeJevClient(options);
    this.#baseUrl = new URL(options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#getAccessToken = options.getAccessToken ?? (() => "");
    this.#expectedVersions = options.expectedVersions ?? { api: "v1" };
  }
  scoped(context: OperationContext) {
    return new ScopedKnowledgeClient(this, context);
  }
  getBenchmarkRun(runId: string, context: Pick<OperationContext, "tenantId" | "correlationId">) {
    return this.#request(
      `v1/verification/benchmarks/${encodeURIComponent(UuidSchema.parse(runId))}`,
      undefined,
      VerificationBenchmarkRunSummaryResourceSchema,
      "GET",
      context,
    );
  }
  getBenchmarkRunManifest(runId: string, context: Pick<OperationContext, "tenantId" | "correlationId">) {
    return this.#request(
      `v1/verification/benchmarks/${encodeURIComponent(UuidSchema.parse(runId))}/manifest`,
      undefined,
      VerificationBenchmarkRunManifestResourceSchema,
      "GET",
      context,
    );
  }
  getProviderReconciliation(
    operationId: string,
    providerAttemptId: string,
    context: Pick<OperationContext, "tenantId" | "correlationId">,
  ) {
    return this.#request(
      `v1/verification/extractions/${encodeURIComponent(UuidSchema.parse(operationId))}/provider-attempts/${encodeURIComponent(UuidSchema.parse(providerAttemptId))}/reconciliation`,
      undefined,
      VerificationProviderReconciliationResourceSchema,
      "GET",
      context,
    );
  }
  applyProviderReconciliation(
    operationId: string,
    providerAttemptId: string,
    request: ApplyProviderReconciliationRequest,
    context: Pick<OperationContext, "tenantId" | "correlationId">,
  ) {
    return this.#request(
      `v1/verification/extractions/${encodeURIComponent(UuidSchema.parse(operationId))}/provider-attempts/${encodeURIComponent(UuidSchema.parse(providerAttemptId))}/reconciliation`,
      ApplyProviderReconciliationRequestSchema.parse(request),
      VerificationProviderReconciliationResourceSchema,
      "POST",
      context,
    );
  }
  getStructuredExtraction(operationId: string, context: Pick<OperationContext, "tenantId" | "correlationId">) {
    return this.#request(
      `v1/verification/extractions/${encodeURIComponent(UuidSchema.parse(operationId))}`,
      undefined,
      VerificationStructuredExtractionResourceSchema,
      "GET",
      context,
    );
  }
  extractStructuredData(request: ExtractStructuredDataRequest, context: VerificationClientContext) {
    return this.#request(
      "v1/verification/extractions",
      ExtractStructuredDataRequestSchema.parse(request),
      AcceptedOperationSchema,
      "POST",
      context,
      this.#verificationHeaders(context),
    );
  }
  getBenchmarkComparison(comparisonId: string, context: Pick<OperationContext, "tenantId" | "correlationId">) {
    return this.#request(
      `v1/verification/benchmarks/comparisons/${encodeURIComponent(UuidSchema.parse(comparisonId))}`,
      undefined,
      VerificationBenchmarkComparisonResourceSchema,
      "GET",
      context,
    );
  }
  submitA2ATask(taskValue: A2ATask) {
    const task = A2ATaskSchema.parse(taskValue);
    return this.#request("v1/a2a/tasks", task, A2AStatusSchema, "POST", task.context);
  }
  submitA2ACallback(
    envelopeValue: CallbackEnvelope,
    signingKeyReference: string,
    context: Pick<OperationContext, "tenantId" | "correlationId">,
  ) {
    const envelope = CallbackEnvelopeSchema.parse(envelopeValue);
    return this.#request("v1/a2a/callbacks", envelope, CallbackAcknowledgementSchema, "POST", context, {
      "x-knowledge-callback-signing-key-reference": signingKeyReference,
    });
  }
  async validateRetrievalPlan(plan: RetrievalPlan, context: OperationContext): Promise<RetrievalPlan> {
    return this.#request(
      "v1/retrieval-plans:validate",
      { plan: RetrievalPlanSchema.parse(plan) },
      RetrievalPlanSchema,
      "POST",
      context,
    );
  }
  async submitOperation(
    kind: OperationKind,
    input: JsonValue,
    context: OperationContext,
    path = "v1/operations",
    expectedVersions: Readonly<Record<string, string>> = this.#expectedVersions,
  ): Promise<AcceptedOperation> {
    const body =
      path === "v1/operations"
        ? { kind, envelope: { context, input, expectedVersions } }
        : { context, input, expectedVersions };
    return this.#request(path, body, AcceptedOperationSchema, "POST", context);
  }
  createRetrievalRun(plan: RetrievalPlan, context: OperationContext) {
    return this.submitOperation(
      "retrieval_run",
      { plan: RetrievalPlanSchema.parse(plan) } as unknown as JsonValue,
      context,
      "v1/retrieval-runs",
      { ...this.#expectedVersions, retrieval: "v1" },
    );
  }
  createVectorStore(input: VectorStoreCreateInput, context: OperationContext) {
    return this.submitOperation(
      "vector_store_create",
      VectorStoreCreateInputSchema.parse(input) as unknown as JsonValue,
      context,
      "v1/vector-stores",
    );
  }
  attachVectorStoreDocuments(vectorStoreId: string, input: VectorStoreDocumentsInput, context: OperationContext) {
    const parsed = VectorStoreDocumentsInputSchema.parse(input);
    if (parsed.vectorStoreId !== vectorStoreId) throw new Error("VECTOR_STORE_PATH_INPUT_MISMATCH");
    return this.submitOperation(
      "vector_store_documents",
      parsed as unknown as JsonValue,
      context,
      `v1/vector-stores/${encodeURIComponent(vectorStoreId)}/documents`,
    );
  }
  startVectorStoreIngestion(vectorStoreId: string, input: VectorStoreIngestionInput, context: OperationContext) {
    const parsed = VectorStoreIngestionInputSchema.parse(input);
    if (parsed.vectorStoreId !== vectorStoreId) throw new Error("VECTOR_STORE_PATH_INPUT_MISMATCH");
    return this.submitOperation(
      "vector_store_ingestion",
      parsed as unknown as JsonValue,
      context,
      `v1/vector-stores/${encodeURIComponent(vectorStoreId)}/ingestion-jobs`,
    );
  }
  discoverSources(input: JsonValue, context: OperationContext) {
    return this.submitOperation("source_discovery", input, context, "v1/sources:discover");
  }
  resolveSource(input: JsonValue, context: OperationContext) {
    return this.submitOperation("source_resolution", input, context, "v1/sources:resolve");
  }
  inspectCapture(id: string, input: JsonValue, context: OperationContext) {
    return this.submitOperation("capture_inspection", input, context, `v1/captures/${encodeURIComponent(id)}:inspect`);
  }
  vetCapture(id: string, input: JsonValue, context: OperationContext) {
    return this.submitOperation("source_vetting", input, context, `v1/captures/${encodeURIComponent(id)}:vet`);
  }
  createTransformation(input: JsonValue, context: OperationContext) {
    return this.submitOperation("transformation", input, context, "v1/transformations");
  }
  previewChunks(input: JsonValue, context: OperationContext) {
    return this.submitOperation("chunk_preview", input, context, "v1/chunk-previews");
  }
  createChunkSet(input: JsonValue, context: OperationContext) {
    return this.submitOperation("chunk_set", input, context, "v1/chunk-sets");
  }
  submitPromotionProposal(input: JsonValue, context: OperationContext) {
    return this.submitOperation("promotion_proposal", input, context, "v1/promotion-proposals");
  }
  startEmbeddingRun(input: JsonValue, context: OperationContext) {
    return this.submitOperation("embedding_run", input, context, "v1/embedding-runs");
  }
  startSpacePublication(input: JsonValue, context: OperationContext) {
    return this.submitOperation("space_publication", input, context, "v1/space-publications");
  }
  verifySpacePublication(id: string, input: JsonValue, context: OperationContext) {
    return this.submitOperation(
      "publication_verification",
      input,
      context,
      `v1/space-publications/${encodeURIComponent(id)}:verify`,
    );
  }
  rollbackSpacePublication(id: string, input: JsonValue, context: OperationContext) {
    return this.submitOperation(
      "publication_rollback",
      input,
      context,
      `v1/space-publications/${encodeURIComponent(id)}:rollback`,
    );
  }
  searchVectorStore(id: string, input: JsonValue, context: OperationContext) {
    return this.submitOperation(
      "vector_store_search",
      input,
      context,
      `v1/vector-stores/${encodeURIComponent(id)}:search`,
    );
  }
  evaluateVectorStore(id: string, input: JsonValue, context: OperationContext) {
    return this.submitOperation(
      "vector_store_evaluation",
      input,
      context,
      `v1/vector-stores/${encodeURIComponent(id)}:evaluate`,
    );
  }
  startEvaluationRun(input: JsonValue, context: OperationContext) {
    return this.submitOperation("evaluation_run", input, context, "v1/eval-runs");
  }
  startExploratoryBundleEvaluation(bundles: readonly ExploratoryBundleDescriptor[], context: OperationContext) {
    return this.submitOperation(
      "evaluation_run",
      {
        mode: "three_bundle_internal_exploratory",
        bundles: [...bundles],
      } as JsonValue,
      context,
      "v1/demo/evaluations",
    );
  }
  captureVerificationSource(request: CaptureSourceRequest, context: VerificationClientContext) {
    return this.#request(
      "v1/verification/captures",
      CaptureSourceRequestSchema.parse(request),
      AcceptedOperationSchema,
      "POST",
      context,
      this.#verificationHeaders(context),
    );
  }
  captureVerificationSourceWithProfile(
    profileName: string,
    request: CaptureSourceRequest,
    context: { correlationId: string; idempotencyKey: string },
  ) {
    const name = z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,63}$/u)
      .parse(profileName);
    return this.#request(
      `v1/verification/benchmark-capture-profiles/${name}/captures`,
      CaptureSourceRequestSchema.parse(request),
      VerificationProfileCaptureAcceptedSchema,
      "POST",
      undefined,
      {
        "x-correlation-id": z.string().min(1).max(255).parse(context.correlationId),
        "idempotency-key": z.string().min(8).max(255).parse(context.idempotencyKey),
      },
    );
  }
  parseArtifact(request: ParseArtifactRequest, context: VerificationClientContext) {
    return this.#request(
      "v1/verification/artifacts:parse",
      ParseArtifactRequestSchema.parse(request),
      AcceptedOperationSchema,
      "POST",
      context,
      this.#verificationHeaders(context),
    );
  }
  getVerificationCaptureResult(
    operationId: string,
    context: Pick<VerificationClientContext, "tenantId" | "correlationId">,
  ) {
    return this.#request(
      `v1/verification/captures/${UuidSchema.parse(operationId)}`,
      undefined,
      VerificationCaptureTerminalResourceSchema,
      "GET",
      context,
    );
  }
  runBenchmark(request: RunBenchmarkRequest, context: VerificationClientContext) {
    return this.#request(
      "v1/verification/benchmarks:run",
      RunBenchmarkRequestSchema.parse(request),
      AcceptedOperationSchema,
      "POST",
      context,
      this.#verificationHeaders(context),
    );
  }
  compareBenchmarkRuns(request: CompareBenchmarkRunsRequest, context: VerificationClientContext) {
    return this.#request(
      "v1/verification/benchmarks:compare",
      CompareBenchmarkRunsRequestSchema.parse(request),
      AcceptedOperationSchema,
      "POST",
      context,
      this.#verificationHeaders(context),
    );
  }
  verifyExtraction(request: VerifyExtractionRequest, context: VerificationClientContext) {
    return this.#request(
      "v1/verification/extractions:verify",
      VerifyExtractionRequestSchema.parse(request),
      AcceptedOperationSchema,
      "POST",
      context,
      this.#verificationHeaders(context),
    );
  }
  replayVerificationRun(request: ReplayRunRequest, context: VerificationClientContext) {
    const parsed = ReplayRunRequestSchema.parse(request);
    return this.#request(
      `v1/verification/runs/${encodeURIComponent(parsed.runId)}:replay`,
      parsed,
      AcceptedOperationSchema,
      "POST",
      context,
      this.#verificationHeaders(context),
    );
  }
  getVerificationOperation(
    operationId: string,
    context: Pick<VerificationClientContext, "tenantId" | "correlationId">,
  ) {
    return this.#request(
      `v1/verification/operations/${encodeURIComponent(operationId)}`,
      undefined,
      OperationStatusSchema,
      "GET",
      context,
    );
  }
  getOperation(
    operationId: string,
    context: Pick<OperationContext, "tenantId" | "correlationId">,
  ): Promise<OperationStatus> {
    return this.#request(
      `v1/operations/${encodeURIComponent(operationId)}`,
      undefined,
      OperationStatusSchema,
      "GET",
      context,
    );
  }
  getVectorStore(vectorStoreId: string, context: Pick<OperationContext, "tenantId" | "correlationId">) {
    return this.#request(
      `v1/vector-stores/${encodeURIComponent(vectorStoreId)}`,
      undefined,
      VectorStoreResourceSchema,
      "GET",
      context,
    );
  }
  getVectorStoreOperation(
    vectorStoreId: string,
    operationId: string,
    context: Pick<OperationContext, "tenantId" | "correlationId">,
  ): Promise<OperationStatus> {
    return this.#request(
      `v1/vector-stores/${encodeURIComponent(vectorStoreId)}/operations/${encodeURIComponent(operationId)}`,
      undefined,
      OperationStatusSchema,
      "GET",
      context,
    );
  }
  getOperationEvents(operationId: string, context: Pick<OperationContext, "tenantId" | "correlationId">, after = 0) {
    return this.#request(
      `v1/operations/${encodeURIComponent(operationId)}/events?after=${after}`,
      undefined,
      EventPageSchema,
      "GET",
      context,
    );
  }
  cancelOperation(operationId: string, context: OperationContext) {
    return this.#request(
      `v1/operations/${encodeURIComponent(operationId)}:cancel`,
      {
        context,
        input: { operationId, action: "cancel" },
        expectedVersions: this.#expectedVersions,
      },
      OperationStatusSchema,
      "POST",
      context,
    );
  }
  retryOperation(operationId: string, context: OperationContext) {
    return this.#request(
      `v1/operations/${encodeURIComponent(operationId)}:retry`,
      {
        context,
        input: { operationId, action: "retry" },
        expectedVersions: this.#expectedVersions,
      },
      OperationStatusSchema,
      "POST",
      context,
    );
  }
  reconcileOperation(operationId: string, context: OperationContext) {
    return this.#request(
      `v1/operations/${encodeURIComponent(operationId)}:reconcile`,
      {
        context,
        input: { operationId, action: "reconcile" },
        expectedVersions: this.#expectedVersions,
      },
      OperationStatusSchema,
      "POST",
      context,
    );
  }
  getEvidencePacket(
    packetId: string,
    context?: Pick<OperationContext, "tenantId" | "correlationId">,
  ): Promise<EvidencePacket> {
    return this.#request(
      `v1/evidence-packets/${encodeURIComponent(packetId)}`,
      undefined,
      EvidencePacketSchema,
      "GET",
      context,
    );
  }
  replayEvidencePacketCitations(packetId: string, context: Pick<OperationContext, "tenantId" | "correlationId">) {
    return this.#request(
      `v1/evidence-packets/${encodeURIComponent(packetId)}/citations`,
      undefined,
      RetrievalCitationReplaySchema,
      "GET",
      context,
    );
  }
  getArtifact(artifactId: string, context: Pick<OperationContext, "tenantId" | "correlationId">) {
    return this.#request(
      `v1/artifacts/${encodeURIComponent(artifactId)}`,
      undefined,
      ArtifactResourceSchema,
      "GET",
      context,
    );
  }
  getReceipt(receiptId: string, context: Pick<OperationContext, "tenantId" | "correlationId">) {
    return this.#request(
      `v1/receipts/${encodeURIComponent(receiptId)}`,
      undefined,
      DurableReceiptResourceSchema,
      "GET",
      context,
    );
  }
  getRetrievalRun(runId: string, context: Pick<OperationContext, "tenantId" | "correlationId">) {
    return this.#request(
      `v1/retrieval-runs/${encodeURIComponent(runId)}`,
      undefined,
      RetrievalRunResourceSchema,
      "GET",
      context,
    );
  }
  getRetrievalExplanation(runId: string, context: Pick<OperationContext, "tenantId" | "correlationId">) {
    return this.#request(
      `v1/retrieval-runs/${encodeURIComponent(runId)}/explanation`,
      undefined,
      RetrievalExplanationResourceSchema,
      "GET",
      context,
    );
  }
  getEvaluationReport(
    runId: string,
    context: Pick<OperationContext, "tenantId" | "correlationId" | "externalExecution">,
  ) {
    return this.#request(
      `v1/eval-runs/${encodeURIComponent(runId)}/report`,
      undefined,
      EvaluationReportResourceSchema,
      "GET",
      context,
    );
  }
  getEvaluationFailures(runId: string, context: Pick<OperationContext, "tenantId" | "correlationId">) {
    return this.#request(
      `v1/eval-runs/${encodeURIComponent(runId)}/failures`,
      undefined,
      EvaluationFailuresResourceSchema,
      "GET",
      context,
    );
  }
  #verificationHeaders(context: VerificationClientContext): Readonly<Record<string, string>> {
    const external = context.externalExecution;
    return {
      "idempotency-key": context.idempotencyKey,
      ...(context.attemptId ? { "x-verification-attempt-id": context.attemptId } : {}),
      ...(context.workItemId ? { "x-verification-work-item-id": context.workItemId } : {}),
      ...(context.missionId ? { "x-verification-mission-id": context.missionId } : {}),
      ...(context.causationId ? { "x-causation-id": context.causationId } : {}),
      ...(external
        ? {
            "x-external-runtime": external.runtime,
            "x-external-run-id": external.runId,
            ...(external.rootRunId ? { "x-external-root-run-id": external.rootRunId } : {}),
            ...(external.sessionId ? { "x-external-session-id": external.sessionId } : {}),
            ...(external.turnId ? { "x-external-turn-id": external.turnId } : {}),
            ...(external.toolCallId ? { "x-external-tool-call-id": external.toolCallId } : {}),
          }
        : {}),
    };
  }
  async #request<T>(
    path: string,
    body: unknown,
    schema: z.ZodType<T>,
    method: string,
    context?: Pick<OperationContext, "tenantId" | "correlationId"> &
      Partial<Pick<OperationContext, "externalExecution">>,
    additionalHeaders: Readonly<Record<string, string>> = {},
  ): Promise<T> {
    const token = await this.#getAccessToken();
    const external = context?.externalExecution;
    const response = await this.#fetch(new URL(path, this.#baseUrl), {
      method,
      headers: {
        accept: "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(context
          ? {
              "x-tenant-id": context.tenantId,
              "x-correlation-id": context.correlationId,
            }
          : {}),
        ...(external
          ? {
              "x-external-runtime": external.runtime,
              "x-external-run-id": external.runId,
              ...(external.rootRunId ? { "x-external-root-run-id": external.rootRunId } : {}),
              ...(external.sessionId ? { "x-eve-session-id": external.sessionId } : {}),
              ...(external.turnId ? { "x-eve-turn-id": external.turnId } : {}),
              ...(external.toolCallId ? { "x-eve-tool-call-id": external.toolCallId } : {}),
            }
          : {}),
        ...additionalHeaders,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload: unknown = await response.json();
    if (!response.ok) throw new KnowledgeClientError(ProblemDetailsSchema.parse(payload));
    return schema.parse(payload);
  }
}

export class ScopedKnowledgeClient {
  constructor(
    private readonly client: KnowledgeClient,
    readonly context: OperationContext,
  ) {}
  validateRetrievalPlan(plan: RetrievalPlan) {
    return this.client.validateRetrievalPlan(plan, this.context);
  }
  retrieve(plan: RetrievalPlan) {
    return this.client.createRetrievalRun(plan, this.context);
  }
  operation(id: string) {
    return this.client.getOperation(id, this.context);
  }
  vectorStore(id: string) {
    return this.client.getVectorStore(id, this.context);
  }
  vectorStoreOperation(storeId: string, operationId: string) {
    return this.client.getVectorStoreOperation(storeId, operationId, this.context);
  }
  events(id: string, after = 0) {
    return this.client.getOperationEvents(id, this.context, after);
  }
  cancel(id: string) {
    return this.client.cancelOperation(id, this.context);
  }
  retry(id: string) {
    return this.client.retryOperation(id, this.context);
  }
  reconcile(id: string) {
    return this.client.reconcileOperation(id, this.context);
  }
  getEvidencePacket(id: string) {
    return this.client.getEvidencePacket(id, this.context);
  }
  getArtifact(id: string) {
    return this.client.getArtifact(id, this.context);
  }
  getReceipt(id: string) {
    return this.client.getReceipt(id, this.context);
  }
  getRetrievalRun(id: string) {
    return this.client.getRetrievalRun(id, this.context);
  }
  getRetrievalExplanation(id: string) {
    return this.client.getRetrievalExplanation(id, this.context);
  }
  getEvaluationReport(id: string) {
    return this.client.getEvaluationReport(id, this.context);
  }
  getEvaluationFailures(id: string) {
    return this.client.getEvaluationFailures(id, this.context);
  }
  discoverSources(input: JsonValue) {
    return this.client.discoverSources(input, this.context);
  }
  vetCapture(id: string, input: JsonValue) {
    return this.client.vetCapture(id, input, this.context);
  }
  startExploratoryBundleEvaluation(bundles: readonly ExploratoryBundleDescriptor[]) {
    return this.client.startExploratoryBundleEvaluation(bundles, this.context);
  }
}
