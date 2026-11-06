import { A2AKnowledgeAdapter, operationEnvelopeForA2ATask } from "./a2a-adapter.js";
import {
  CallbackReplayGuard,
  authenticateCallback,
  submitCanonicalRetrievalRun,
  type CallbackReplayStore,
  type KnowledgeOperationPort,
} from "@aiengineer/knowledge-application";
import { A2ATaskSchema, CallbackAcknowledgementSchema, type ProblemDetails } from "@aiengineer/knowledge-contracts";
import { actorsMatch, type ApiAction, type LocalApiIdentity } from "@aiengineer/knowledge-host";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { CanonicalRetrievalExecutorPort } from "@aiengineer/knowledge-application";
import { sendProblem } from "./http/problem-map.js";
import type { ServerOptionDependencies } from "./http/context.js";

export interface A2ARouteServices
  extends Pick<
    ServerOptionDependencies,
    "callbackReplayStore" | "resolveCallbackSigningSecret" | "callbackClock" | "maximumCallbackAgeMs"
  > {}

export type ResolveCallbackSigningSecret = (
  tenantId: string,
  signingKeyReference: string,
) => string | undefined | Promise<string | undefined>;

const callbackSigningKeysSchema = z.array(
  z.strictObject({
    tenantId: z.uuid(),
    signingKeyReference: z.string().trim().min(1).max(255),
    secret: z.string().min(32),
  }),
);

export function createCallbackSigningSecretResolver(
  raw = process.env.KNOWLEDGE_CALLBACK_SIGNING_KEYS,
): ResolveCallbackSigningSecret {
  if (!raw?.trim()) return () => undefined;
  const entries = callbackSigningKeysSchema.parse(JSON.parse(raw));
  const secrets = new Map<string, string>();
  for (const entry of entries) {
    const key = `${entry.tenantId}\0${entry.signingKeyReference}`;
    if (secrets.has(key)) throw new Error("DUPLICATE_CALLBACK_SIGNING_KEY_REFERENCE");
    secrets.set(key, entry.secret);
  }
  return (tenantId, signingKeyReference) => secrets.get(`${tenantId}\0${signingKeyReference}`);
}

interface AuthorizedAccess {
  readonly tenant: string;
  readonly identity: LocalApiIdentity;
}

export interface A2AHttpRouteDependencies {
  readonly operationService: KnowledgeOperationPort;
  readonly retrievalOperationService?: KnowledgeOperationPort;
  readonly canonicalRetrievalExecutor?: CanonicalRetrievalExecutorPort;
  readonly requireAccess: (
    request: FastifyRequest,
    reply: FastifyReply,
    action: ApiAction,
  ) => Promise<AuthorizedAccess | undefined>;
  readonly correlationId: (request: FastifyRequest) => string;
  readonly origin: (request: FastifyRequest) => string;
  readonly problem: (
    status: number,
    code: ProblemDetails["code"],
    title: string,
    correlationId: string,
    detail?: string,
  ) => ProblemDetails;
  readonly resolveCallbackSigningSecret?: ResolveCallbackSigningSecret;
  readonly callbackReplayStore?: CallbackReplayStore;
  readonly callbackClock?: () => Date;
  readonly maximumCallbackAgeMs?: number;
}

export function registerA2AHttpRoutes(server: FastifyInstance, dependencies: A2AHttpRouteDependencies): void {
  const replayStore = dependencies.callbackReplayStore ?? new CallbackReplayGuard();
  const resolveSecret = dependencies.resolveCallbackSigningSecret ?? (() => undefined);

  server.post("/v1/a2a/tasks", async (request, reply) => {
    const access = await dependencies.requireAccess(request, reply, "operation.submit");
    if (!access) return;
    const task = A2ATaskSchema.parse(request.body);
    if (task.context.tenantId !== access.tenant)
      return sendProblem(
        reply,
        dependencies.problem(403, "FORBIDDEN", "Tenant context mismatch", dependencies.correlationId(request)),
      );
    if (!actorsMatch(access.identity.actor, task.context.actor))
      return sendProblem(
        reply,
        dependencies.problem(
          403,
          "FORBIDDEN",
          "Authenticated actor does not match A2A task actor",
          dependencies.correlationId(request),
        ),
      );
    if (task.context.correlationId !== dependencies.correlationId(request))
      return sendProblem(
        reply,
        dependencies.problem(
          400,
          "INVALID_CONTRACT",
          "Correlation context mismatch",
          dependencies.correlationId(request),
        ),
      );
    let status;
    if (task.kind === "retrieval") {
      if (!dependencies.retrievalOperationService || !dependencies.canonicalRetrievalExecutor)
        return sendProblem(
          reply,
          dependencies.problem(
            503,
            "INTERNAL_ERROR",
            "Canonical retrieval executor unavailable",
            dependencies.correlationId(request),
          ),
        );
      const envelope = operationEnvelopeForA2ATask(task);
      const submission = await submitCanonicalRetrievalRun(
        {
          operations: dependencies.retrievalOperationService,
          executor: dependencies.canonicalRetrievalExecutor,
        },
        { envelope, identity: access.identity, origin: dependencies.origin(request) },
      );
      if (!submission.ok && submission.reason === "retrieval_version_required")
        return sendProblem(
          reply,
          dependencies.problem(
            400,
            "INVALID_CONTRACT",
            "Retrieval contract version v1 is required",
            dependencies.correlationId(request),
          ),
        );
      if (!submission.ok)
        return sendProblem(
          reply,
          dependencies.problem(
            503,
            "INTERNAL_ERROR",
            "Canonical retrieval executor unavailable",
            dependencies.correlationId(request),
          ),
        );
      status = {
        taskId: task.taskId,
        operationId: submission.accepted.operationId,
        state: "accepted" as const,
        statusUrl: submission.accepted.statusUrl,
        eventStreamUrl: submission.accepted.eventStreamUrl,
        cancellationUrl: submission.accepted.cancellationUrl,
      };
    } else
      status = await new A2AKnowledgeAdapter(dependencies.operationService, dependencies.origin(request)).dispatch(
        task,
      );
    return reply.status(202).send(status);
  });

  server.post("/v1/a2a/callbacks", async (request, reply) => {
    const access = await dependencies.requireAccess(request, reply, "callback.receive");
    if (!access) return;
    const signingKeyHeader = request.headers["x-knowledge-callback-signing-key-reference"];
    const signingKeyReference = typeof signingKeyHeader === "string" ? signingKeyHeader.trim() : "";
    if (!signingKeyReference || signingKeyReference.length > 255)
      return sendProblem(
        reply,
        dependencies.problem(
          400,
          "INVALID_CONTRACT",
          "Callback signing-key reference required",
          dependencies.correlationId(request),
        ),
      );
    const secret = await resolveSecret(access.tenant, signingKeyReference);
    if (!secret)
      return sendProblem(
        reply,
        dependencies.problem(
          401,
          "UNAUTHORIZED",
          "Callback authentication failed",
          dependencies.correlationId(request),
        ),
      );
    const envelope = authenticateCallback(request.body, secret, {
      ...(dependencies.callbackClock ? { now: dependencies.callbackClock } : {}),
      ...(dependencies.maximumCallbackAgeMs ? { maximumAgeMs: dependencies.maximumCallbackAgeMs } : {}),
    });
    if (!envelope)
      return sendProblem(
        reply,
        dependencies.problem(
          401,
          "UNAUTHORIZED",
          "Callback authentication failed",
          dependencies.correlationId(request),
        ),
      );
    if (envelope.tenantId !== access.tenant || envelope.correlationId !== dependencies.correlationId(request))
      return sendProblem(
        reply,
        dependencies.problem(
          403,
          "FORBIDDEN",
          "Callback execution context mismatch",
          dependencies.correlationId(request),
        ),
      );
    const operation = await dependencies.operationService.get(envelope.operationId, access.tenant);
    if (!operation)
      return sendProblem(
        reply,
        dependencies.problem(404, "NOT_FOUND", "Callback operation not found", dependencies.correlationId(request)),
      );
    if (
      operation.context.correlationId !== envelope.correlationId ||
      (operation.context.causationId ?? undefined) !== (envelope.causationId ?? undefined)
    )
      return sendProblem(
        reply,
        dependencies.problem(
          403,
          "FORBIDDEN",
          "Callback lineage does not match the admitted operation",
          dependencies.correlationId(request),
        ),
      );
    const operationInput = await dependencies.operationService.input(envelope.operationId, access.tenant);
    const binding = a2aCallbackBinding(operationInput);
    if (!binding || binding.taskId !== envelope.taskId || binding.signingKeyReference !== signingKeyReference)
      return sendProblem(
        reply,
        dependencies.problem(
          403,
          "FORBIDDEN",
          "Callback task binding does not match the admitted A2A task",
          dependencies.correlationId(request),
        ),
      );
    const receivedAt = (dependencies.callbackClock ?? (() => new Date()))().toISOString();
    const receiverIdentity = `${access.identity.actor.kind}:${access.identity.actor.id}`;
    const accepted = await replayStore.accept(envelope, signingKeyReference, receivedAt, receiverIdentity);
    if (!accepted)
      return sendProblem(
        reply,
        dependencies.problem(409, "CONFLICT", "Callback replay rejected", dependencies.correlationId(request)),
      );
    return reply.status(202).send(
      CallbackAcknowledgementSchema.parse({
        callbackId: envelope.callbackId,
        operationId: envelope.operationId,
        state: "accepted",
        receivedAt,
      }),
    );
  });
}

function a2aCallbackBinding(value: unknown): { taskId: string; signingKeyReference: string } | undefined {
  if (!isRecord(value) || !isRecord(value.a2a) || !isRecord(value.a2a.callback)) return undefined;
  const taskId = value.a2a.taskId;
  const signingKeyReference = value.a2a.callback.signingKeyReference;
  return typeof taskId === "string" && typeof signingKeyReference === "string"
    ? { taskId, signingKeyReference }
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
