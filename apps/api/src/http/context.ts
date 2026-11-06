import { VerificationProfileCaptureAcceptedSchema } from "@aiengineer/knowledge-contracts";
import {
  bindResolvedVerificationContext,
  createVerificationResourceReads,
  type VerificationContextBindingFailure,
  type VerificationResourceReadServices,
} from "@aiengineer/knowledge-host";
import { ApplyProviderReconciliationRequestSchema } from "@aiengineer/knowledge-contracts";
import { ExtractStructuredDataRequestSchema, type ExtractStructuredDataRequest } from "@aiengineer/knowledge-contracts";
import {
  CompareBenchmarkRunsRequestSchema,
  type CompareBenchmarkRunsRequest,
  RunBenchmarkRequestSchema,
  type RunBenchmarkRequest,
} from "@aiengineer/knowledge-contracts";
import { ParseArtifactRequestSchema, type ParseArtifactRequest } from "@aiengineer/knowledge-contracts";
import {
  AgenticKnowledgeService,
  createIntegrationService,
  createKnowledgeApplication,
  VerificationOperationApplicationService,
  type KnowledgeIntegrationService,
  type KnowledgeOperationPort,
  type CallbackReplayStore,
  type VerificationBenchmarkReadService,
  type VerificationBenchmarkComparisonReadService,
} from "@aiengineer/knowledge-host";
import {
  ExploratoryEvaluationInputSchema,
  MutationEnvelopeSchema,
  OperationKindSchema,
  OperationContextSchema,
  CaptureSourceRequestSchema,
  VerifyExtractionRequestSchema,
  ReplayRunRequestSchema,
  VerificationOperationContextHintsSchema,
  RetrievalPlanSchema,
  VectorStoreCreateInputSchema,
  VectorStoreDocumentsInputSchema,
  VectorStoreIngestionInputSchema,
  UuidSchema,
  type EvidencePacket,
  type RetrievalCitationReplay,
  type OperationKind,
  type OperationContext,
  type VerificationOperationContextHints,
} from "@aiengineer/knowledge-contracts";
import type { ResourceReadRepository } from "@aiengineer/knowledge-host";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { DeterministicFakeEmbeddingAdapter } from "@aiengineer/knowledge-host";
import { z, ZodError, type ZodType } from "zod";
import {
  actorsMatch,
  isAuthorized,
  requiredSubmissionAction,
  type LocalApiIdentity,
  type ResolveApiIdentity,
} from "@aiengineer/knowledge-host/config";
import { registerA2AHttpRoutes, type ResolveCallbackSigningSecret } from "../a2a-http.js";
import {
  createKnowledgeResourceReads,
  submitCanonicalRetrievalRun,
  type CanonicalRetrievalExecutorPort,
  type VettedBundleInput,
} from "@aiengineer/knowledge-host";
import { correlationId, registerCorrelation, tenantId } from "../plugins/correlation.js";
import { createAuthGuards } from "../plugins/auth.js";
import { registerProblemHandler, type UnexpectedErrorRecord } from "../plugins/problem.js";
import { problem } from "./problem-map.js";
import { reconciliationTitles, sendKnowledgeRead, sendVerificationRead } from "./read-map.js";

export interface ServerOptionDependencies {
  logUnexpectedError?: (record: UnexpectedErrorRecord) => void;
  /**
   * Demo-only port for POST /v1/demo/evaluations: loads the allow-listed exploratory
   * bundles. Unset, the route answers 503 (fixture unavailable); the server never imports
   * test fixtures itself.
   */
  loadDemoEvaluationBundles?: () => Promise<readonly VettedBundleInput[]>;
  service?: KnowledgeIntegrationService;
  operationService?: KnowledgeOperationPort;
  retrievalOperationService?: KnowledgeOperationPort;
  resourceReader?: ResourceReadRepository;
  maximumResourceResponseBytes?: number;
  publicOrigin?: string;
  resolveIdentity?: ResolveApiIdentity;
  replayEvidencePacketCitations?: (tenantId: string, packetId: string) => Promise<RetrievalCitationReplay>;
  getEvidencePacket?: (
    tenantId: string,
    packetId: string,
  ) => EvidencePacket | undefined | Promise<EvidencePacket | undefined>;
  callbackReplayStore?: CallbackReplayStore;
  resolveCallbackSigningSecret?: ResolveCallbackSigningSecret;
  callbackClock?: () => Date;
  maximumCallbackAgeMs?: number;
  canonicalRetrievalExecutor?: CanonicalRetrievalExecutorPort;
  /** Dedicated verification operations remain unavailable unless both trusted ports are configured. */
  verificationOperationService?: KnowledgeOperationPort;
  verificationCaptureCatalog?: import("@aiengineer/knowledge-host").VerificationServiceCatalog;
  verificationBenchmarkReads?: Pick<VerificationBenchmarkReadService, "getRun" | "getManifest">;
  verificationBenchmarkComparisonReads?: Pick<VerificationBenchmarkComparisonReadService, "getComparison">;
  verificationProviderReconciliation?: VerificationResourceReadServices["providerReconciliation"];
  verificationStructuredExtractionReads?: {
    getExtraction(input: {
      tenantId: string;
      operationId: string;
      actor: import("@aiengineer/knowledge-contracts").Actor;
    }): Promise<import("@aiengineer/knowledge-contracts").VerificationStructuredExtractionResource>;
  };
  verificationCaptureReads?: {
    getCapture(input: {
      tenantId: string;
      operationId: string;
      actor: import("@aiengineer/knowledge-contracts").Actor;
    }): Promise<import("@aiengineer/knowledge-contracts").VerificationCaptureTerminalResource>;
  };
  isStructuredExtractionRequestAdmitted?: (tenantId: string, request: ExtractStructuredDataRequest) => boolean;
  isBenchmarkRequestAdmitted?: (tenantId: string, request: RunBenchmarkRequest) => boolean;
  isBenchmarkComparisonRequestAdmitted?: (tenantId: string, request: CompareBenchmarkRunsRequest) => boolean;
  /** Exact trusted capture grants are checked before an operation is enqueued. */
  isParseArtifactRequestAdmitted?: (tenantId: string, request: ParseArtifactRequest) => boolean;
  resolveVerificationBenchmarkCaptureProfile?: (input: {
    profileName: string;
    identity: LocalApiIdentity;
    correlationId: string;
    idempotencyKey: string;
  }) => Promise<OperationContext | undefined>;
  resolveVerificationContext?: (input: {
    readonly request: FastifyRequest;
    readonly tenantId: string;
    readonly identity: LocalApiIdentity;
    readonly correlationId: string;
    readonly idempotencyKey: string;
    readonly useCase:
      | "captureSource"
      | "parseArtifact"
      | "verifyExtraction"
      | "replayRun"
      | "runBenchmark"
      | "compareBenchmarkRuns"
      | "extractStructuredData";
    readonly hints: VerificationOperationContextHints;
  }) => OperationContext | undefined | Promise<OperationContext | undefined>;
  /** Test/contract hook invoked for every route registered with Fastify. */
  observeRoute?: (method: string, path: string) => void;
}
const VERIFICATION_CONTEXT_BINDING_TITLES: Readonly<Record<VerificationContextBindingFailure, string>> = {
  ownership_denied: "Verification operation ownership denied",
  context_mismatch: "Trusted verification context mismatch",
  ownership_binding_mismatch: "Trusted verification ownership binding mismatch",
  external_execution_mismatch: "Trusted external execution binding mismatch",
};
const collectionKinds: Record<string, OperationKind> = {
  "vector-stores": "vector_store_create",
  captures: "capture",
  documents: "document",
  "document-versions": "document_version",
  representations: "representation",
  "promotion-proposals": "promotion_proposal",
  "promotion-decisions": "promotion_decision",
  "embedding-runs": "embedding_run",
  "space-publications": "space_publication",
  "eval-datasets": "evaluation_dataset",
  experiments: "experiment",
  "eval-runs": "evaluation_run",
  reviews: "review",
  "review-decisions": "review_decision",
};
const operationInputSchemas: Partial<Record<OperationKind, ZodType>> = {
  vector_store_create: VectorStoreCreateInputSchema,
  vector_store_documents: VectorStoreDocumentsInputSchema,
  vector_store_ingestion: VectorStoreIngestionInputSchema,
};
export function createRouteContext(options: ServerOptionDependencies = {}) {
  const server = Fastify({ logger: false });
  if (options.observeRoute)
    server.addHook("onRoute", (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const method of methods) options.observeRoute?.(method, route.url);
    });
  const application = createKnowledgeApplication();
  const service = options.service ?? createIntegrationService();
  const operationService = options.operationService ?? service;
  const retrievalOperationService = options.retrievalOperationService ?? operationService;
  registerCorrelation(server);
  registerProblemHandler(server, options.logUnexpectedError);
  const { resolveBearerIdentity, requireAccess, requireEnvelopeActor, requireSubmissionEnvelope, origin } =
    createAuthGuards(options);
  const requireResourceReader = (request: FastifyRequest, reply: FastifyReply) => {
    if (options.resourceReader) return options.resourceReader;
    void reply
      .status(503)
      .type("application/problem+json")
      .send(problem(503, "INTERNAL_ERROR", "Canonical resource store unavailable", correlationId(request)));
    return undefined;
  };
  const knowledgeReads = createKnowledgeResourceReads({
    ...(options.resourceReader ? { resources: options.resourceReader } : {}),
    operations: operationService,
    ...(options.getEvidencePacket ? { getEvidencePacket: options.getEvidencePacket } : {}),
    ...(options.replayEvidencePacketCitations
      ? { replayEvidencePacketCitations: options.replayEvidencePacketCitations }
      : {}),
    ...(options.maximumResourceResponseBytes === undefined
      ? {}
      : { maximumResponseBytes: options.maximumResourceResponseBytes }),
  });
  const verificationReads = createVerificationResourceReads({
    ...(options.verificationStructuredExtractionReads
      ? { structuredExtractionReads: options.verificationStructuredExtractionReads }
      : {}),
    ...(options.verificationCaptureReads ? { captureReads: options.verificationCaptureReads } : {}),
    ...(options.verificationBenchmarkComparisonReads
      ? { benchmarkComparisonReads: options.verificationBenchmarkComparisonReads }
      : {}),
    ...(options.verificationBenchmarkReads ? { benchmarkReads: options.verificationBenchmarkReads } : {}),
    ...(options.verificationProviderReconciliation
      ? { providerReconciliation: options.verificationProviderReconciliation }
      : {}),
    ...(options.maximumResourceResponseBytes === undefined
      ? {}
      : { maximumResponseBytes: options.maximumResourceResponseBytes }),
  });
  const verificationContext = async (
    request: FastifyRequest,
    reply: FastifyReply,
    useCase:
      | "captureSource"
      | "parseArtifact"
      | "verifyExtraction"
      | "replayRun"
      | "runBenchmark"
      | "compareBenchmarkRuns"
      | "extractStructuredData",
  ) => {
    const access = await requireAccess(request, reply, "operation.submit");
    if (!access) return undefined;
    if (!options.verificationOperationService || !options.resolveVerificationContext) {
      await reply
        .status(503)
        .type("application/problem+json")
        .send(problem(503, "CAPABILITY_NOT_ADMITTED", "Verification operation unavailable", correlationId(request)));
      return undefined;
    }
    const raw = request.headers["idempotency-key"],
      idempotencyKey = typeof raw === "string" ? raw.trim() : "";
    if (idempotencyKey.length < 8 || idempotencyKey.length > 255) {
      await reply
        .status(400)
        .type("application/problem+json")
        .send(problem(400, "INVALID_CONTRACT", "Idempotency key required", correlationId(request)));
      return undefined;
    }
    const header = (name: string): string | undefined => {
      const value = request.headers[name];
      if (value === undefined) return undefined;
      if (typeof value !== "string" || value.trim() === "") throw new ZodError([]);
      return value.trim();
    };
    const externalHeaders = Object.fromEntries(
      Object.entries({
        runtime: header("x-external-runtime"),
        runId: header("x-external-run-id"),
        rootRunId: header("x-external-root-run-id"),
        sessionId: header("x-external-session-id"),
        turnId: header("x-external-turn-id"),
        toolCallId: header("x-external-tool-call-id"),
      }).filter(([, value]) => value !== undefined),
    );
    const hasExternal = Object.values(externalHeaders).some((value) => value !== undefined);
    const hints = VerificationOperationContextHintsSchema.parse({
      attemptId: header("x-verification-attempt-id"),
      workItemId: header("x-verification-work-item-id"),
      missionId: header("x-verification-mission-id"),
      causationId: header("x-causation-id"),
      ...(hasExternal ? { externalExecution: externalHeaders } : {}),
    });
    const resolved = await options.resolveVerificationContext({
      request,
      tenantId: access.tenant,
      identity: access.identity,
      correlationId: correlationId(request),
      idempotencyKey,
      useCase,
      hints,
    });
    const binding = bindResolvedVerificationContext({
      resolved,
      tenantId: access.tenant,
      actor: access.identity.actor,
      correlationId: correlationId(request),
      idempotencyKey,
      hints,
    });
    if (!binding.ok) {
      await reply
        .status(403)
        .type("application/problem+json")
        .send(problem(403, "FORBIDDEN", VERIFICATION_CONTEXT_BINDING_TITLES[binding.failure], correlationId(request)));
      return undefined;
    }
    const { context } = binding;
    return {
      access,
      context,
      service: new VerificationOperationApplicationService(
        options.verificationOperationService,
        origin(request),
        options.verificationCaptureCatalog,
      ),
    };
  };
  const submit = async (
    request: FastifyRequest,
    reply: FastifyReply,
    kind: OperationKind,
    pathVectorStoreId?: string,
  ) => {
    const access = await requireAccess(request, reply, requiredSubmissionAction(kind));
    if (!access) return;
    const envelope = MutationEnvelopeSchema.parse(request.body);
    operationInputSchemas[kind]?.parse(envelope.input);
    if (!requireSubmissionEnvelope(access, envelope, request, reply)) return;
    if (pathVectorStoreId) {
      const input = envelope.input as { vectorStoreId?: unknown };
      if (input.vectorStoreId !== UuidSchema.parse(pathVectorStoreId))
        return reply
          .status(400)
          .type("application/problem+json")
          .send(
            problem(
              400,
              "INVALID_CONTRACT",
              "Path vector store does not match operation input",
              correlationId(request),
            ),
          );
    }
    return reply.status(202).send(await operationService.submit(kind, envelope, origin(request)));
  };

  registerA2AHttpRoutes(server, {
    operationService,
    retrievalOperationService,
    ...(options.canonicalRetrievalExecutor ? { canonicalRetrievalExecutor: options.canonicalRetrievalExecutor } : {}),
    requireAccess,
    correlationId,
    origin,
    problem,
    ...(options.callbackReplayStore ? { callbackReplayStore: options.callbackReplayStore } : {}),
    ...(options.resolveCallbackSigningSecret
      ? { resolveCallbackSigningSecret: options.resolveCallbackSigningSecret }
      : {}),
    ...(options.callbackClock ? { callbackClock: options.callbackClock } : {}),
    ...(options.maximumCallbackAgeMs ? { maximumCallbackAgeMs: options.maximumCallbackAgeMs } : {}),
  });

  return {
    VerificationProfileCaptureAcceptedSchema,
    ApplyProviderReconciliationRequestSchema,
    ExtractStructuredDataRequestSchema,
    CompareBenchmarkRunsRequestSchema,
    RunBenchmarkRequestSchema,
    ParseArtifactRequestSchema,
    AgenticKnowledgeService,
    VerificationOperationApplicationService,
    ExploratoryEvaluationInputSchema,
    MutationEnvelopeSchema,
    OperationKindSchema,
    OperationContextSchema,
    CaptureSourceRequestSchema,
    VerifyExtractionRequestSchema,
    ReplayRunRequestSchema,
    RetrievalPlanSchema,
    UuidSchema,
    DeterministicFakeEmbeddingAdapter,
    z,
    actorsMatch,
    isAuthorized,
    requiredSubmissionAction,
    submitCanonicalRetrievalRun,
    options,
    server,
    application,
    service,
    operationService,
    retrievalOperationService,
    resolveBearerIdentity,
    requireAccess,
    requireEnvelopeActor,
    requireSubmissionEnvelope,
    origin,
    requireResourceReader,
    knowledgeReads,
    sendKnowledgeRead,
    verificationReads,
    sendVerificationRead,
    reconciliationTitles,
    verificationContext,
    submit,
    collectionKinds,
    correlationId,
    tenantId,
    problem,
  };
}

export type RouteContext = ReturnType<typeof createRouteContext>;
