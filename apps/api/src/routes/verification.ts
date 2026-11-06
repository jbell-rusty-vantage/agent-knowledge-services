import type { FastifyInstance } from "fastify";
import type { RouteContext } from "../server.js";
import { createRouteRegistrar } from "../http/route.js";
import { admitBody } from "../http/admission.js";
import type { ServerOptionDependencies } from "../http/context.js";

type VerificationOptionKey = Extract<
  keyof ServerOptionDependencies,
  `verification${string}` | `is${string}` | `resolveVerification${string}`
>;
export interface VerificationRouteServices extends Pick<ServerOptionDependencies, VerificationOptionKey> {}
type Params = { id: string };

export function registerVerification(server: FastifyInstance, context: RouteContext): void {
  const {
    VerificationProfileCaptureAcceptedSchema,
    ExtractStructuredDataRequestSchema,
    CompareBenchmarkRunsRequestSchema,
    RunBenchmarkRequestSchema,
    ParseArtifactRequestSchema,
    VerificationOperationApplicationService,
    OperationContextSchema,
    CaptureSourceRequestSchema,
    VerifyExtractionRequestSchema,
    ReplayRunRequestSchema,
    UuidSchema,
    z,
    actorsMatch,
    isAuthorized,
    options,
    operationService,
    resolveBearerIdentity,
    requireAccess,
    origin,
    verificationReads,
    sendVerificationRead,
    verificationContext,
    correlationId,
    problem,
  } = context;
  const route = createRouteRegistrar({ server, requireAccess });
  const ownedReads = [
    {
      url: "/v1/verification/extractions/:operationId",
      read: verificationReads.structuredExtraction,
      titles: {
        unavailable: "Extraction reads unavailable",
        notFound: "Extraction not found",
        integrity: "Extraction integrity unavailable",
      },
    },
    {
      url: "/v1/verification/captures/:operationId",
      read: verificationReads.capture,
      titles: {
        unavailable: "Capture reads unavailable",
        notFound: "Capture result not found",
        pending: "Capture result is not terminal",
        terminal: (state: string) => `Capture terminal state: ${state}`,
        integrity: "Capture custody integrity unavailable",
      },
    },
  ];
  for (const entry of ownedReads) {
    route({
      method: "GET",
      url: entry.url,
      access: "knowledge.read",
      params: z.strictObject({ operationId: z.string() }),
      query: z.strictObject({}),
      call: async ({ access, params, request, reply }) =>
        sendVerificationRead(
          request,
          reply,
          await entry.read({
            tenantId: access.tenant,
            operationId: UuidSchema.parse(params.operationId),
            actor: access.identity.actor,
          }),
          entry.titles,
        ),
    });
  }
  server.get<{ Params: { comparisonId: string } }>(
    "/v1/verification/benchmarks/comparisons/:comparisonId",
    async (request, reply) => {
      const access = await requireAccess(request, reply, "knowledge.read");
      if (!access) return;
      z.strictObject({}).parse(request.query);
      const comparisonId = UuidSchema.parse(request.params.comparisonId);
      return sendVerificationRead(
        request,
        reply,
        await verificationReads.benchmarkComparison({
          tenantId: access.tenant,
          comparisonId,
        }),
        {
          unavailable: "Comparison reads unavailable",
          notFound: "Comparison not found",
          integrity: "Comparison integrity unavailable",
        },
      );
    },
  );
  for (const manifest of [false, true]) {
    server.get<{ Params: { runId: string } }>(
      `/v1/verification/benchmarks/:runId${manifest ? "/manifest" : ""}`,
      async (request, reply) => {
        const access = await requireAccess(request, reply, "knowledge.read");
        if (!access) return;
        z.strictObject({}).parse(request.query);
        const input = {
          tenantId: access.tenant,
          runId: UuidSchema.parse(request.params.runId),
        };
        return sendVerificationRead(
          request,
          reply,
          manifest ? await verificationReads.benchmarkManifest(input) : await verificationReads.benchmarkRun(input),
          {
            unavailable: "Benchmark reads unavailable",
            notFound: "Benchmark run not found",
            integrity: "Benchmark integrity unavailable",
          },
        );
      },
    );
  }
  server.post<{ Params: { profileName: string } }>(
    "/v1/verification/benchmark-capture-profiles/:profileName/captures",
    async (request, reply) => {
      const identity = await resolveBearerIdentity(request);
      if (!identity)
        return reply
          .status(401)
          .type("application/problem+json")
          .send(problem(401, "UNAUTHORIZED", "Authentication required", correlationId(request)));
      z.strictObject({}).parse(request.query);
      const profileName = z
        .string()
        .regex(/^[a-z][a-z0-9-]{0,63}$/u)
        .parse(request.params.profileName);
      if (
        Object.keys(request.headers).some(
          (name) =>
            name === "x-tenant-id" ||
            name.startsWith("x-verification-") ||
            name.startsWith("x-external-") ||
            name.startsWith("x-eve-") ||
            name === "x-causation-id",
        )
      )
        return reply
          .status(400)
          .type("application/problem+json")
          .send(problem(400, "INVALID_CONTRACT", "Profile routing is server-owned", correlationId(request)));
      const idempotencyKey = z.string().min(8).max(255).parse(request.headers["idempotency-key"]);
      const input = CaptureSourceRequestSchema.parse(request.body);
      if (input.source.mode !== "acquire")
        return reply
          .status(400)
          .type("application/problem+json")
          .send(problem(400, "INVALID_CONTRACT", "Profile capture requires acquisition", correlationId(request)));
      if (
        !options.resolveVerificationBenchmarkCaptureProfile ||
        !options.verificationOperationService ||
        !options.verificationCaptureCatalog
      )
        return reply
          .status(503)
          .type("application/problem+json")
          .send(problem(503, "CAPABILITY_NOT_ADMITTED", "Profile capture unavailable", correlationId(request)));
      const resolved = await options.resolveVerificationBenchmarkCaptureProfile({
        profileName,
        identity,
        correlationId: correlationId(request),
        idempotencyKey,
      });
      if (!resolved)
        return reply
          .status(404)
          .type("application/problem+json")
          .send(problem(404, "NOT_FOUND", "Capture profile not found", correlationId(request)));
      const context = OperationContextSchema.parse(resolved);
      if (
        !actorsMatch(context.actor, identity.actor) ||
        !isAuthorized(identity, context.tenantId, "operation.submit") ||
        context.correlationId !== correlationId(request) ||
        context.idempotencyKey !== idempotencyKey
      )
        throw new Error("VERIFICATION_PROFILE_CONTEXT_MISMATCH");
      try {
        options.verificationCaptureCatalog.acquisition(context.tenantId, input.source.sourceUri);
      } catch (error) {
        if (error instanceof Error && error.message === "VERIFICATION_ACQUISITION_GRANT_REQUIRED")
          return reply
            .status(403)
            .type("application/problem+json")
            .send(problem(403, "FORBIDDEN", "Source acquisition grant required", correlationId(request)));
        throw error;
      }
      const service = new VerificationOperationApplicationService(
        options.verificationOperationService,
        origin(request),
        options.verificationCaptureCatalog,
      );
      return reply.status(202).send(
        VerificationProfileCaptureAcceptedSchema.parse({
          tenantId: context.tenantId,
          operation: await service.submitCaptureSource(input, context),
        }),
      );
    },
  );
  server.post("/v1/verification/captures", async (request, reply) => {
    const trusted = await verificationContext(request, reply, "captureSource");
    if (!trusted) return;
    const input = CaptureSourceRequestSchema.parse(request.body);
    if (input.source.mode === "acquire") {
      if (!options.verificationCaptureCatalog)
        return reply
          .status(503)
          .type("application/problem+json")
          .send(problem(503, "CAPABILITY_NOT_ADMITTED", "Source acquisition unavailable", correlationId(request)));
      try {
        options.verificationCaptureCatalog.acquisition(trusted.context.tenantId, input.source.sourceUri);
      } catch (error) {
        if (error instanceof Error && error.message === "VERIFICATION_ACQUISITION_GRANT_REQUIRED")
          return reply
            .status(403)
            .type("application/problem+json")
            .send(problem(403, "FORBIDDEN", "Source acquisition grant required", correlationId(request)));
        throw error;
      }
    }
    return reply.status(202).send(await trusted.service.submitCaptureSource(input, trusted.context));
  });
  server.post("/v1/verification/artifacts::parse", async (request, reply) => {
    const trusted = await verificationContext(request, reply, "parseArtifact");
    if (!trusted) return;
    const policy = options.isParseArtifactRequestAdmitted;
    const admitted = await admitBody({
      request,
      reply,
      parse: (body) => ParseArtifactRequestSchema.parse(body),
      admission: policy && ((body) => policy(trusted.context.tenantId, body)),
      unavailable: "Parse runtime unavailable",
      denied: "Parse capture grant required",
    });
    if (!admitted) return;
    return reply.status(202).send(await trusted.service.submitParseArtifact(admitted.body, trusted.context));
  });
  server.post("/v1/verification/extractions", async (request, reply) => {
    const trusted = await verificationContext(request, reply, "extractStructuredData");
    if (!trusted) return;
    const policy = options.isStructuredExtractionRequestAdmitted;
    const admitted = await admitBody({
      request,
      reply,
      parse: (body) => ExtractStructuredDataRequestSchema.parse(body),
      admission: policy && ((body) => policy(trusted.context.tenantId, body)),
      unavailable: "Extraction runtime unavailable",
      denied: "Extraction input grant required",
    });
    if (!admitted) return;
    return reply.status(202).send(await trusted.service.submitExtractStructuredData(admitted.body, trusted.context));
  });
  server.post("/v1/verification/benchmarks::run", async (request, reply) => {
    const trusted = await verificationContext(request, reply, "runBenchmark");
    if (!trusted) return;
    const policy = options.isBenchmarkRequestAdmitted;
    const admitted = await admitBody({
      request,
      reply,
      parse: (body) => RunBenchmarkRequestSchema.parse(body),
      admission: policy && ((body) => policy(trusted.context.tenantId, body)),
      unavailable: "Benchmark runtime unavailable",
      denied: "Benchmark input grant required",
    });
    if (!admitted) return;
    return reply.status(202).send(await trusted.service.submitRunBenchmark(admitted.body, trusted.context));
  });
  server.post("/v1/verification/benchmarks::compare", async (request, reply) => {
    const trusted = await verificationContext(request, reply, "compareBenchmarkRuns");
    if (!trusted) return;
    const policy = options.isBenchmarkComparisonRequestAdmitted;
    const admitted = await admitBody({
      request,
      reply,
      parse: (body) => CompareBenchmarkRunsRequestSchema.parse(body),
      admission: policy && ((body) => policy(trusted.context.tenantId, body)),
      unavailable: "Comparison runtime unavailable",
      denied: "Comparison profile grant required",
    });
    if (!admitted) return;
    return reply.status(202).send(await trusted.service.submitCompareBenchmarkRuns(admitted.body, trusted.context));
  });
  server.post("/v1/verification/extractions::verify", async (request, reply) => {
    const trusted = await verificationContext(request, reply, "verifyExtraction");
    if (!trusted) return;
    return reply
      .status(202)
      .send(
        await trusted.service.submitVerifyExtraction(
          VerifyExtractionRequestSchema.parse(request.body),
          trusted.context,
        ),
      );
  });
  server.post<{ Params: { runId: string } }>("/v1/verification/runs/:runId(^[^:]+)::replay", async (request, reply) => {
    const trusted = await verificationContext(request, reply, "replayRun");
    if (!trusted) return;
    const parsed = ReplayRunRequestSchema.parse(request.body);
    if (parsed.runId !== request.params.runId)
      return reply
        .status(400)
        .type("application/problem+json")
        .send(problem(400, "INVALID_CONTRACT", "Path run does not match replay request", correlationId(request)));
    return reply.status(202).send(await trusted.service.submitReplayRun(parsed, trusted.context));
  });
  server.get<{ Params: Params }>("/v1/verification/operations/:id", async (request, reply) => {
    const access = await requireAccess(request, reply, "knowledge.read");
    if (!access) return;
    const item = await (options.verificationOperationService ?? operationService).get(request.params.id, access.tenant);
    return (
      item ??
      reply.status(404).send(problem(404, "NOT_FOUND", "Verification operation not found", correlationId(request)))
    );
  });
}
