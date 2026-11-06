import {
  assertOperationKindAdmitted,
  actorsMatch,
  bindResolvedVerificationContext,
  isAuthorized,
  productionWorkerOperationKinds,
  requiredSubmissionAction,
  submitCanonicalRetrievalRun,
  transportProblem,
  type CanonicalRetrievalExecutorPort,
  type KnowledgeOperationPort,
  type KnowledgeResourceReads,
  type LocalApiIdentity,
  type ResolveApiIdentity,
  type ResolveVerificationContext,
  type VerificationHostAdmission,
  type VerificationOperationApplicationService,
  type VerificationResourceReads,
} from "@aiengineer/knowledge-host";
import {
  ApplyProviderReconciliationRequestSchema,
  CaptureSourceRequestSchema,
  CompareBenchmarkRunsRequestSchema,
  ExtractStructuredDataRequestSchema,
  JsonValueSchema,
  MutationEnvelopeSchema,
  OperationContextSchema,
  ParseArtifactRequestSchema,
  ReplayRunRequestSchema,
  RetrievalPlanSchema,
  RunBenchmarkRequestSchema,
  UuidSchema,
  VectorStoreCreateInputSchema,
  VectorStoreDocumentsInputSchema,
  VerificationOperationContextHintsSchema,
  VerifyExtractionRequestSchema,
  type OperationContext,
  type OperationKind,
} from "@aiengineer/knowledge-contracts";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { MCP_TOOL_CATALOG, VERIFICATION_MCP_TOOL_NAMES, McpToolName } from "../catalog.js";
import { McpReadContextSchema } from "./definition.js";
import { inProcessRead, readToolResult, toolError } from "./errors.js";

export const McpToolArgumentsSchema = z.object({
  context: OperationContextSchema,
  input: JsonValueSchema,
  expectedVersions: z.record(z.string(), z.string().min(1)),
});
export type McpToolArguments = z.infer<typeof McpToolArgumentsSchema>;

const verificationToolUseCases = {
  verify_extraction_run: "extractStructuredData",
  verify_benchmark_compare: "compareBenchmarkRuns",
  verify_benchmark_run: "runBenchmark",
  verify_benchmark_capture: "captureSource",
  verify_artifact_parse: "parseArtifact",
  verify_extract: "verifyExtraction",
  verify_bundle_replay: "replayRun",
} as const;

export interface KnowledgeMcpServerOptions {
  readonly operationService: KnowledgeOperationPort;
  /** Public API origin used by accepted-operation links, never the MCP origin. */
  readonly apiOrigin: string;
  readonly identity: LocalApiIdentity;
  readonly verificationOperations?: VerificationOperationApplicationService;
  readonly resolveVerificationContext?: ResolveVerificationContext;
  readonly verificationAdmission?: VerificationHostAdmission;
  /** In-process knowledge reads and canonical retrieval; absent capabilities are not admitted. */
  readonly knowledge?: KnowledgeMcpServices;
  /** In-process verification reads, decisions reads and reconciliation; absent means not admitted. */
  readonly verificationReads?: VerificationResourceReads;
  readonly incomingRequest?: {
    readonly headers: Record<string, unknown>;
    readonly body: unknown;
  };
}

export interface KnowledgeMcpServices {
  readonly reads: KnowledgeResourceReads;
  /** Admits API-owned synchronous kinds; knowledge_retrieve_search submits through it before executing. */
  readonly retrievalOperations?: Pick<KnowledgeOperationPort, "submit">;
  readonly retrievalExecutor?: CanonicalRetrievalExecutorPort;
}

const verificationContextSchema = McpReadContextSchema.extend({
  idempotencyKey: z.string().trim().min(8).max(255),
  ...VerificationOperationContextHintsSchema.shape,
});
export const verificationToolSchemas = {
  verify_extraction_run: z.strictObject({
    context: verificationContextSchema,
    request: ExtractStructuredDataRequestSchema,
  }),
  verify_benchmark_compare: z.strictObject({
    context: verificationContextSchema,
    request: CompareBenchmarkRunsRequestSchema,
  }),
  verify_benchmark_run: z.strictObject({
    context: verificationContextSchema,
    request: RunBenchmarkRequestSchema,
  }),
  verify_benchmark_capture: z.strictObject({
    context: verificationContextSchema,
    request: CaptureSourceRequestSchema,
  }),
  verify_artifact_parse: z.strictObject({
    context: verificationContextSchema,
    request: ParseArtifactRequestSchema,
  }),
  verify_extract: z.strictObject({
    context: verificationContextSchema,
    request: VerifyExtractionRequestSchema,
  }),
  verify_bundle_replay: z.strictObject({
    context: verificationContextSchema,
    request: ReplayRunRequestSchema,
  }),
} as const;

type VerificationMcpToolName = (typeof VERIFICATION_MCP_TOOL_NAMES)[number];
type VerificationAdmissionResult = "ok" | "CAPABILITY_NOT_ADMITTED" | "FORBIDDEN";
type VerificationAdmissionGate = (tenantId: string, request: never) => boolean | Promise<boolean>;

const VERIFICATION_MCP_ADMISSION_GATES: {
  readonly [Name in VerificationMcpToolName]?: (
    admission: VerificationHostAdmission,
  ) => VerificationAdmissionGate | undefined;
} = {
  verify_artifact_parse: (admission) => admission.isParseArtifactRequestAdmitted,
  verify_extraction_run: (admission) => admission.isStructuredExtractionRequestAdmitted,
  verify_benchmark_run: (admission) => admission.isBenchmarkRequestAdmitted,
  verify_benchmark_compare: (admission) => admission.isBenchmarkComparisonRequestAdmitted,
};

const VERIFICATION_IN_PROCESS_SUBMIT: {
  readonly [Name in VerificationMcpToolName]: (
    operations: VerificationOperationApplicationService,
    request: unknown,
    context: OperationContext,
  ) => unknown;
} = {
  verify_extraction_run: (operations, request, context) => operations.submitExtractStructuredData(request, context),
  verify_benchmark_compare: (operations, request, context) => operations.submitCompareBenchmarkRuns(request, context),
  verify_benchmark_run: (operations, request, context) => operations.submitRunBenchmark(request, context),
  verify_benchmark_capture: (operations, request, context) => operations.submitCaptureSource(request, context),
  verify_artifact_parse: (operations, request, context) => operations.submitParseArtifact(request, context),
  verify_extract: (operations, request, context) => operations.submitVerifyExtraction(request, context),
  verify_bundle_replay: (operations, request, context) => operations.submitReplayRun(request, context),
};

async function admitVerificationMcpRequest(input: {
  readonly name: VerificationMcpToolName;
  readonly tenantId: string;
  readonly request: unknown;
  readonly admission: VerificationHostAdmission | undefined;
}): Promise<VerificationAdmissionResult> {
  const selectGate = VERIFICATION_MCP_ADMISSION_GATES[input.name];
  if (selectGate === undefined) return "ok";
  const gate = input.admission ? selectGate(input.admission) : undefined;
  if (gate === undefined) return "CAPABILITY_NOT_ADMITTED";
  if (!(await gate(input.tenantId, input.request as never))) return "FORBIDDEN";
  return "ok";
}

async function executeVerificationInProcess(input: {
  readonly name: VerificationMcpToolName;
  readonly parsed: z.infer<(typeof verificationToolSchemas)[VerificationMcpToolName]>;
  readonly options: KnowledgeMcpServerOptions;
}) {
  const { name, parsed, options } = input;
  const resolved = await options.resolveVerificationContext!({
    ...(options.incomingRequest ? { request: options.incomingRequest } : {}),
    tenantId: parsed.context.tenantId,
    identity: options.identity,
    correlationId: parsed.context.correlationId,
    idempotencyKey: parsed.context.idempotencyKey,
    useCase: verificationToolUseCases[name],
    hints: parsed.context,
  });
  // The API route's trusted-context binding: tenant, correlation, idempotency, actor and hints.
  const binding = bindResolvedVerificationContext({
    resolved,
    tenantId: parsed.context.tenantId,
    actor: options.identity.actor,
    correlationId: parsed.context.correlationId,
    idempotencyKey: parsed.context.idempotencyKey,
    hints: parsed.context,
  });
  if (!binding.ok) return toolError("FORBIDDEN");
  const context = binding.context;
  const admission = await admitVerificationMcpRequest({
    name,
    tenantId: context.tenantId,
    request: parsed.request,
    admission: options.verificationAdmission,
  });
  if (admission !== "ok") return toolError(admission);
  const result = await VERIFICATION_IN_PROCESS_SUBMIT[name](options.verificationOperations!, parsed.request, context);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: result as unknown as Record<string, unknown>,
  };
}

export function createVerificationMcpToolExecutor(options: KnowledgeMcpServerOptions) {
  return async (name: (typeof VERIFICATION_MCP_TOOL_NAMES)[number], value: unknown) => {
    const parsed = verificationToolSchemas[name].parse(value),
      context = parsed.context;
    if (!isAuthorized(options.identity, context.tenantId, "operation.submit")) return toolError("FORBIDDEN");
    // Submission is in process only. Without trusted operations and ownership resolution
    // the capability is not admitted.
    if (!options.verificationOperations || !options.resolveVerificationContext)
      return toolError("CAPABILITY_NOT_ADMITTED");
    return executeVerificationInProcess({ name, parsed, options });
  };
}

export const benchmarkReadSchema = z.strictObject({
  context: McpReadContextSchema,
  runId: z.uuid(),
});
export const comparisonReadSchema = z.strictObject({
  context: benchmarkReadSchema.shape.context,
  comparisonId: z.uuid(),
});
export const reconciliationReadSchema = z.strictObject({
  context: benchmarkReadSchema.shape.context,
  operationId: z.uuid(),
  providerAttemptId: z.uuid(),
});
export const reconciliationApplySchema = reconciliationReadSchema.extend(
  ApplyProviderReconciliationRequestSchema.shape,
);
export function createProviderReconciliationMcpExecutor(options: KnowledgeMcpServerOptions, action: "apply" | "show") {
  return async (value: unknown) => {
    const parsed = (action === "apply" ? reconciliationApplySchema : reconciliationReadSchema).parse(value);
    if (
      !isAuthorized(
        options.identity,
        parsed.context.tenantId,
        action === "apply" ? "operation.submit" : "knowledge.read",
      )
    )
      return toolError("FORBIDDEN");
    const reads = options.verificationReads;
    if (!reads) return toolError("CAPABILITY_NOT_ADMITTED");
    return readToolResult(
      await reads.providerReconciliation({
        tenantId: parsed.context.tenantId,
        actor: options.identity.actor,
        operationId: parsed.operationId,
        providerAttemptId: parsed.providerAttemptId,
        ...("artifact" in parsed
          ? {
              artifact: ApplyProviderReconciliationRequestSchema.parse({
                artifact: parsed.artifact,
              }).artifact,
            }
          : {}),
      }),
    );
  };
}
export const extractionReadSchema = z.strictObject({
  context: benchmarkReadSchema.shape.context,
  operationId: z.uuid(),
});
export function createStructuredExtractionReadMcpExecutor(options: KnowledgeMcpServerOptions) {
  return async (value: unknown) => {
    const { context, operationId } = extractionReadSchema.parse(value);
    if (!isAuthorized(options.identity, context.tenantId, "knowledge.read")) return toolError("FORBIDDEN");
    const reads = options.verificationReads;
    if (!reads) return toolError("CAPABILITY_NOT_ADMITTED");
    return readToolResult(
      await reads.structuredExtraction({
        tenantId: context.tenantId,
        operationId,
        actor: options.identity.actor,
      }),
    );
  };
}
export function createBenchmarkComparisonReadMcpExecutor(options: KnowledgeMcpServerOptions) {
  return async (value: unknown) => {
    const { context, comparisonId } = comparisonReadSchema.parse(value);
    if (!isAuthorized(options.identity, context.tenantId, "knowledge.read")) return toolError("FORBIDDEN");
    const reads = options.verificationReads;
    if (!reads) return toolError("CAPABILITY_NOT_ADMITTED");
    return readToolResult(await reads.benchmarkComparison({ tenantId: context.tenantId, comparisonId }));
  };
}
export function createBenchmarkReadMcpExecutor(options: KnowledgeMcpServerOptions) {
  return async (name: "verify_benchmark_show" | "verify_benchmark_manifest", value: unknown) => {
    const { context, runId } = benchmarkReadSchema.parse(value);
    if (!isAuthorized(options.identity, context.tenantId, "knowledge.read")) return toolError("FORBIDDEN");
    const reads = options.verificationReads;
    if (!reads) return toolError("CAPABILITY_NOT_ADMITTED");
    const input = { tenantId: context.tenantId, runId };
    return name === "verify_benchmark_show"
      ? readToolResult(await reads.benchmarkRun(input))
      : readToolResult(await reads.benchmarkManifest(input));
  };
}

export interface KnowledgeMcpAppOptions {
  readonly operationService: KnowledgeOperationPort;
  readonly apiOrigin: string;
  readonly resolveIdentity: ResolveApiIdentity;
  readonly verificationOperations?: VerificationOperationApplicationService;
  readonly resolveVerificationContext?: ResolveVerificationContext;
  readonly verificationAdmission?: VerificationHostAdmission;
  readonly knowledge?: KnowledgeMcpServices;
  readonly verificationReads?: VerificationResourceReads;
}

async function searchCanonicalRetrieval(options: KnowledgeMcpServerOptions, context: OperationContext, plan: unknown) {
  const knowledge = options.knowledge;
  if (!knowledge?.retrievalOperations || !knowledge.retrievalExecutor) return toolError("CAPABILITY_NOT_ADMITTED");
  // The envelope the public client submitted: JSON-normalized, retrieval contract v1.
  const envelope = MutationEnvelopeSchema.parse(
    JSON.parse(
      JSON.stringify({
        context,
        input: { plan: RetrievalPlanSchema.parse(plan) },
        expectedVersions: { api: "v1", retrieval: "v1" },
      }),
    ),
  );
  try {
    const submission = await submitCanonicalRetrievalRun(
      {
        operations: knowledge.retrievalOperations,
        executor: knowledge.retrievalExecutor,
      },
      { envelope, identity: options.identity, origin: options.apiOrigin },
    );
    if (!submission.ok) return toolError("CAPABILITY_NOT_ADMITTED");
    return {
      content: [{ type: "text" as const, text: JSON.stringify(submission.accepted) }],
      structuredContent: submission.accepted as unknown as Record<string, unknown>,
    };
  } catch (error) {
    const problem = transportProblem(error);
    return problem.response === undefined ? toolError(problem.code) : toolError(problem.code, problem.response);
  }
}

/**
 * Creates a handler shared by every bounded MCP tool. It is deliberately a
 * transport adapter: durable admission, idempotency and step planning remain
 * in the injected application port.
 */
export function createMcpToolExecutor(options: KnowledgeMcpServerOptions) {
  return async (name: keyof typeof MCP_TOOL_CATALOG, kind: OperationKind, argumentsValue: unknown) => {
    const { context, input, expectedVersions } = McpToolArgumentsSchema.parse(argumentsValue);
    const readTools = new Set([
      "knowledge_chunk_strategies",
      "knowledge_retrieve_plan",
      "knowledge_retrieve_explain",
      "knowledge_retrieve_run",
      "knowledge_retrieve_packet",
      "knowledge_retrieve_citations",
      "knowledge_eval_failures",
      "knowledge_embed_status",
      "knowledge_promotion_status",
      "knowledge_store_status",
    ]);
    if (
      !isAuthorized(
        options.identity,
        context.tenantId,
        readTools.has(name) ? "knowledge.read" : requiredSubmissionAction(kind),
      )
    )
      return toolError("FORBIDDEN");
    if (!actorsMatch(options.identity.actor, context.actor)) return toolError("ACTOR_MISMATCH");
    const inputObject =
      input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
    const uuid = (name: string) => {
      const parsed = UuidSchema.safeParse(inputObject[name]);
      return parsed.success ? parsed.data : undefined;
    };
    const reads = options.knowledge?.reads;
    const success = (value: unknown): CallToolResult => ({
      content: [{ type: "text", text: JSON.stringify(value) }],
      structuredContent: value as Record<string, unknown>,
    });
    const operationStatus = async () => {
      const id = uuid("operationId");
      if (!id) return toolError("RESOURCE_ID_REQUIRED");
      const item = await options.operationService.get(id, context.tenantId);
      if (!item) throw Object.assign(new Error("NOT_FOUND"), { code: "NOT_FOUND" });
      return success(item);
    };
    const packetId = () => {
      const id = uuid("packetId");
      return id && !Object.keys(inputObject).some((key) => key !== "packetId") ? id : undefined;
    };
    const readPacket = async () => {
      if (!reads) return toolError("CAPABILITY_NOT_ADMITTED");
      const id = packetId();
      return id ? inProcessRead(() => reads.evidencePacket(context.tenantId, id)) : toolError("RESOURCE_ID_REQUIRED");
    };
    const replayCitations = async () => {
      if (!reads) return toolError("CAPABILITY_NOT_ADMITTED");
      const id = packetId();
      return id ? inProcessRead(() => reads.citationReplay(context.tenantId, id)) : toolError("RESOURCE_ID_REQUIRED");
    };
    const readHandlers: Partial<Record<McpToolName, () => Promise<CallToolResult>>> = {
      knowledge_chunk_strategies: async () =>
        success({
          items: [
            { id: "heading-sections-v1", version: "1.0.0", admitted: true },
            { id: "transcript-topics-v1", version: "1.0.0", admitted: true },
          ],
          nextCursor: null,
        }),
      knowledge_retrieve_plan: async () => success(RetrievalPlanSchema.parse(inputObject.plan ?? inputObject)),
      knowledge_retrieve_search: async () =>
        options.knowledge
          ? searchCanonicalRetrieval(options, context, inputObject.plan ?? inputObject)
          : toolError("CAPABILITY_NOT_ADMITTED"),
      knowledge_retrieve_explain: async () => {
        if (!reads) return toolError("CAPABILITY_NOT_ADMITTED");
        const id = uuid("runId");
        return id
          ? inProcessRead(() => reads.retrievalExplanation(context.tenantId, id))
          : toolError("RESOURCE_ID_REQUIRED");
      },
      knowledge_retrieve_run: async () => {
        if (!reads) return toolError("CAPABILITY_NOT_ADMITTED");
        const id = uuid("runId");
        if (!id || Object.keys(inputObject).some((key) => key !== "runId")) return toolError("RESOURCE_ID_REQUIRED");
        return inProcessRead(() => reads.retrievalRun(context.tenantId, id));
      },
      knowledge_retrieve_packet: readPacket,
      knowledge_retrieve_citations: replayCitations,
      knowledge_eval_failures: async () => {
        if (!reads) return toolError("CAPABILITY_NOT_ADMITTED");
        const id = uuid("runId");
        return id
          ? inProcessRead(() => reads.evaluationFailures(context.tenantId, id))
          : toolError("RESOURCE_ID_REQUIRED");
      },
      knowledge_embed_status: operationStatus,
      knowledge_promotion_status: operationStatus,
      knowledge_store_status: async () => {
        if (!reads) return toolError("CAPABILITY_NOT_ADMITTED");
        const storeId = uuid("vectorStoreId");
        const operationId = uuid("operationId");
        if (!storeId || !operationId) return toolError("RESOURCE_ID_REQUIRED");
        return inProcessRead(() => reads.vectorStoreOperation(context.tenantId, storeId, operationId));
      },
      knowledge_embed_models: async () => toolError("CAPABILITY_NOT_ADMITTED"),
      knowledge_embed_estimate: async () => toolError("CAPABILITY_NOT_ADMITTED"),
    };
    const readHandler = readHandlers[name];
    if (readHandler) return readHandler();
    try {
      assertOperationKindAdmitted(kind, productionWorkerOperationKinds);
    } catch {
      return toolError("CAPABILITY_NOT_ADMITTED");
    }
    if (kind === "vector_store_create") VectorStoreCreateInputSchema.parse(input);
    if (kind === "vector_store_documents") VectorStoreDocumentsInputSchema.parse(input);
    const result = await options.operationService.submit(kind, { context, input, expectedVersions }, options.apiOrigin);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
      structuredContent: result,
    };
  };
}

export const verificationOperationReadSchema = z.strictObject({
  context: McpReadContextSchema,
  operationId: z.uuid(),
});
/** Verification-aware operation poll (spec §19 `knowledge_get_operation`): state + receipt ids only, never a synthesized result. */
export function createVerificationOperationReadMcpExecutor(options: KnowledgeMcpServerOptions) {
  return async (value: unknown) => {
    const { context, operationId } = verificationOperationReadSchema.parse(value);
    if (!isAuthorized(options.identity, context.tenantId, "knowledge.read")) return toolError("FORBIDDEN");
    const result = await options.operationService.get(operationId, context.tenantId);
    if (!result) throw Object.assign(new Error("NOT_FOUND"), { code: "NOT_FOUND" });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  };
}
