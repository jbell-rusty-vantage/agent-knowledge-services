import {
  A2AResultSchema,
  A2ATaskSchema,
  CallbackAcknowledgementSchema,
  CallbackEnvelopeSchema,
  type A2ATask,
  type CallbackAcknowledgement,
  type CallbackEnvelope,
  type JsonValue,
} from "@aiengineer/knowledge-contracts";
import { canonicalJson, sha256Digest } from "@aiengineer/knowledge-core";
import { deterministicUuid } from "@aiengineer/knowledge-core";
import { createHmac, timingSafeEqual } from "node:crypto";

export interface CallbackReplayStore {
  accept(
    envelope: CallbackEnvelope,
    signingKeyReference: string,
    receivedAt: string,
    receiverIdentity: string,
  ): boolean | Promise<boolean>;
}

/** Process-local replay protection for tests and explicitly local runtimes. */
export class CallbackReplayGuard implements CallbackReplayStore {
  readonly #seen = new Set<string>();

  accept(envelope: CallbackEnvelope): boolean {
    if (this.#seen.has(envelope.callbackId)) return false;
    this.#seen.add(envelope.callbackId);
    return true;
  }
}

function signatureInput(envelope: Omit<CallbackEnvelope, "signature">): string {
  return canonicalJson(envelope as unknown as JsonValue);
}

export function signCallback(
  input: Omit<CallbackEnvelope, "signature" | "payloadDigest" | "signatureVersion"> & { payload: JsonValue },
  secret: string,
): CallbackEnvelope {
  if (Buffer.byteLength(secret, "utf8") < 32) throw new Error("CALLBACK_SIGNING_SECRET_TOO_SHORT");
  const unsigned = {
    ...input,
    payloadDigest: sha256Digest(input.payload),
    signatureVersion: "hmac-sha256-v1" as const,
  };
  const signature = `sha256=${createHmac("sha256", secret).update(signatureInput(unsigned)).digest("hex")}`;
  return CallbackEnvelopeSchema.parse({ ...unsigned, signature });
}

/** Checks schema, payload integrity, HMAC, and freshness without consuming replay state. */
export function authenticateCallback(
  envelopeValue: unknown,
  secret: string,
  options: { now?: () => Date; maximumAgeMs?: number } = {},
): CallbackEnvelope | undefined {
  const parsed = CallbackEnvelopeSchema.safeParse(envelopeValue);
  if (!parsed.success || Buffer.byteLength(secret, "utf8") < 32) return undefined;
  const envelope = parsed.data;
  const occurredAt = Date.parse(envelope.occurredAt);
  const now = (options.now ?? (() => new Date()))().getTime();
  const maximumAgeMs = options.maximumAgeMs ?? 5 * 60_000;
  if (!Number.isFinite(occurredAt) || maximumAgeMs < 1 || occurredAt > now + 30_000 || now - occurredAt > maximumAgeMs)
    return undefined;
  if (sha256Digest(envelope.payload) !== envelope.payloadDigest) return undefined;
  const expected = signCallback(
    {
      callbackId: envelope.callbackId,
      tenantId: envelope.tenantId,
      taskId: envelope.taskId,
      operationId: envelope.operationId,
      correlationId: envelope.correlationId,
      ...(envelope.causationId ? { causationId: envelope.causationId } : {}),
      occurredAt: envelope.occurredAt,
      payload: envelope.payload,
    },
    secret,
  );
  const actualBytes = Buffer.from(envelope.signature, "utf8");
  const expectedBytes = Buffer.from(expected.signature, "utf8");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
    ? envelope
    : undefined;
}

/** Backward-compatible combined verifier for process-local callers. */
export function verifyCallback(
  envelopeValue: unknown,
  secret: string,
  guard: CallbackReplayGuard,
  options: { now?: () => Date; maximumAgeMs?: number } = {},
): boolean {
  const envelope = authenticateCallback(envelopeValue, secret, options);
  return envelope ? guard.accept(envelope) : false;
}

export interface ResolvedCallbackTarget {
  readonly url: string;
  readonly authenticationReference: string;
  readonly signingKeyReference: string;
  readonly bearerToken: string;
  readonly signingSecret: string;
}

export type ResolveCallbackTarget = (
  task: A2ATask,
) => ResolvedCallbackTarget | undefined | Promise<ResolvedCallbackTarget | undefined>;

/** Authenticated, signed HTTP callback sender with no redirects or caller-selected destinations. */
export class A2ACallbackHttpSender {
  constructor(
    private readonly resolveTarget: ResolveCallbackTarget,
    private readonly fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
    private readonly timeoutMs = 10_000,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("INVALID_CALLBACK_TIMEOUT");
  }

  async sendResult(taskValue: unknown, resultValue: unknown): Promise<CallbackAcknowledgement> {
    const task = A2ATaskSchema.parse(taskValue);
    const result = A2AResultSchema.parse(resultValue);
    if (result.taskId !== task.taskId || result.operationId !== task.context.operationId)
      throw new Error("CALLBACK_RESULT_CONTEXT_MISMATCH");
    const target = await this.resolveTarget(task);
    if (!target) throw new Error("CALLBACK_TARGET_NOT_ADMITTED");
    assertTargetMatchesTask(task, target);
    const envelope = callbackEnvelopeForA2ATask(
      task,
      result as unknown as JsonValue,
      target.signingSecret,
      new Date().toISOString(),
    );
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImplementation(target.url, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${target.bearerToken}`,
          "content-type": "application/json",
          "x-tenant-id": task.context.tenantId,
          "x-correlation-id": task.context.correlationId,
          "x-knowledge-callback-signing-key-reference": target.signingKeyReference,
        },
        body: JSON.stringify(envelope),
      });
      if (!response.ok) throw new Error(`CALLBACK_DELIVERY_FAILED:${response.status}`);
      return CallbackAcknowledgementSchema.parse(await readBoundedJson(response));
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Builds the signed callback envelope for a task result; the callback id is deterministic per tenant, task and payload. */
export function callbackEnvelopeForA2ATask(
  task: A2ATask,
  payload: JsonValue,
  secret: string,
  occurredAt: string,
): CallbackEnvelope {
  return signCallback(
    {
      callbackId: deterministicUuid("a2a-callback", `${task.context.tenantId}:${task.taskId}:${sha256Digest(payload)}`),
      tenantId: task.context.tenantId,
      taskId: task.taskId,
      operationId: task.context.operationId,
      correlationId: task.context.correlationId,
      ...(task.context.causationId ? { causationId: task.context.causationId } : {}),
      occurredAt,
      payload,
    },
    secret,
  );
}

function assertTargetMatchesTask(task: A2ATask, target: ResolvedCallbackTarget): void {
  if (
    target.url !== task.callback.url ||
    target.authenticationReference !== task.callback.authenticationReference ||
    target.signingKeyReference !== task.callback.signingKeyReference ||
    !target.bearerToken ||
    Buffer.byteLength(target.signingSecret, "utf8") < 32
  )
    throw new Error("CALLBACK_TARGET_CONTRACT_MISMATCH");
  const url = new URL(target.url);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error("UNSAFE_CALLBACK_TARGET");
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > 64 * 1024) throw new Error("CALLBACK_RESPONSE_TOO_LARGE");
  if (!response.body) throw new Error("CALLBACK_RESPONSE_MISSING");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > 64 * 1024) {
      await reader.cancel();
      throw new Error("CALLBACK_RESPONSE_TOO_LARGE");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return JSON.parse(text) as unknown;
}
