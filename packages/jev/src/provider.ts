import { z } from "zod";
import type { JevAnswer, JevResult, ResolvedJevRequest } from "./contracts.js";
import { JevError } from "./contracts.js";
import { readBoundedBody } from "./inputs.js";

export class ProviderFailure extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly retryAfterMs = 0,
  ) {
    super(code);
  }
}
export interface ProviderCall {
  request: ResolvedJevRequest;
  endpoint?: string;
  timeoutMs: number;
}
const probability = z.number().min(0).max(1);
const distribution = z.record(z.string(), probability);
const rawAnswer = z.object({
  type: z.string(),
  choice: z.string().optional(),
  score: z.number().finite().optional(),
  probabilities: distribution.optional(),
  confidence: probability.optional(),
  noul: probability.optional(),
  probability: probability.optional(),
});
const responseSchema = z.object({
  model: z.string().optional(),
  answers: z.record(z.string(), rawAnswer),
  usage: z.object({
    input_tokens: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative().optional(),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
  }),
  providerMetadata: z
    .object({
      typesafe: z
        .object({ confidence: z.record(z.string(), probability).optional() })
        .passthrough()
        .optional(),
      gateway: z.object({ generationId: z.string().optional() }).passthrough().optional(),
    })
    .passthrough()
    .optional(),
});

function normalizeAnswers(
  body: z.infer<typeof responseSchema>,
  request: ResolvedJevRequest,
): Record<string, JevAnswer> {
  const output: Record<string, JevAnswer> = Object.create(null) as Record<string, JevAnswer>;
  if (Object.keys(body.answers).length !== Object.keys(request.questions).length)
    throw new ProviderFailure("PROVIDER_ANSWER_MISMATCH", false);
  for (const [id, question] of Object.entries(request.questions)) {
    const answer = body.answers[id];
    if (!answer) throw new ProviderFailure("PROVIDER_ANSWER_MISMATCH", false);
    if (question.type === "noul") {
      const noul = request.provider === "gateway" ? answer.probability : answer.noul;
      if (noul === undefined || !["boolean", "noul"].includes(answer.type))
        throw new ProviderFailure("PROVIDER_ANSWER_MISMATCH", false);
      output[id] = { type: "noul", noul };
      continue;
    }
    const probabilities = answer.probabilities;
    const options =
      question.type === "choice" ? Object.keys(question.criteria) : question.criteria.map((_, i) => String(i));
    if (
      answer.type !== question.type ||
      !probabilities ||
      Object.keys(probabilities).length !== options.length ||
      options.some((option) => probabilities[option] === undefined)
    )
      throw new ProviderFailure("PROVIDER_ANSWER_MISMATCH", false);
    const mass = Object.values(probabilities).reduce((sum, p) => sum + p, 0);
    const roundingTolerance = request.provider === "gateway" ? options.length * 0.005 + 0.001 : 0.02;
    if (Math.abs(mass - 1) > roundingTolerance) throw new ProviderFailure("PROVIDER_PROBABILITY_MASS", false);
    const confidence = answer.confidence ?? body.providerMetadata?.typesafe?.confidence?.[id];
    const extras = confidence === undefined ? {} : { confidence };
    if (question.type === "choice") {
      if (answer.choice === undefined || !Object.hasOwn(question.criteria, answer.choice))
        throw new ProviderFailure("PROVIDER_CHOICE_OUTSIDE_SCHEMA", false);
      output[id] = { type: "choice", choice: answer.choice, probabilities, ...extras };
    } else {
      if (answer.score === undefined || answer.score < 0 || answer.score > question.criteria.length - 1)
        throw new ProviderFailure("PROVIDER_SCORE_OUTSIDE_SCHEMA", false);
      output[id] = { type: "score", score: answer.score, probabilities, ...extras };
    }
  }
  return output;
}

export async function callProvider(call: ProviderCall): Promise<JevResult> {
  const { request } = call;
  const key = process.env[request.provider === "gateway" ? "AI_GATEWAY_API_KEY" : "JEV_API_KEY"];
  if (!key) throw new ProviderFailure("PROVIDER_KEY_MISSING", false);
  const endpoint =
    call.endpoint ??
    (request.provider === "gateway"
      ? "https://ai-gateway.vercel.sh/v1/evaluate"
      : "https://api.typesafe.ai/v1/systemone");
  const questions = Object.fromEntries(
    Object.entries(request.questions).map(([id, question]) => [
      id,
      question.type === "noul" && request.provider === "gateway" ? { ...question, type: "boolean" } : question,
    ]),
  );
  const startedAt = performance.now();
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(call.timeoutMs),
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: request.model, state: request.state, questions }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      const retryAfter = response.headers.get("retry-after");
      const seconds = Number(retryAfter);
      const delay =
        retryAfter === null ? 0 : Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
      if (delay > 7 * 24 * 60 * 60 * 1000) throw new ProviderFailure("PROVIDER_RETRY_AFTER_EXCEEDS_SEVEN_DAYS", false);
      throw new ProviderFailure(
        `PROVIDER_HTTP_${response.status}`,
        response.status === 429 || response.status >= 500,
        Math.max(0, delay || 0),
      );
    }
    if (!response.body) throw new ProviderFailure("PROVIDER_EMPTY_BODY", false);
    const bytes = await readBoundedBody(response.body, 8 * 1024 * 1024);
    let body: z.infer<typeof responseSchema>;
    try {
      body = responseSchema.parse(JSON.parse(bytes.toString("utf-8")));
    } catch {
      throw new ProviderFailure("PROVIDER_INVALID_RESPONSE", false);
    }
    const inputTokens = body.usage.inputTokens ?? body.usage.input_tokens;
    if (inputTokens === undefined) throw new ProviderFailure("PROVIDER_USAGE_MISSING", false);
    return {
      answers: normalizeAnswers(body, request),
      usage: { inputTokens, outputTokens: body.usage.outputTokens ?? body.usage.output_tokens ?? 0 },
      requestedModel: request.model,
      returnedModel: body.model ?? null,
      provider: request.provider,
      latencyMs: Math.round(performance.now() - startedAt),
      requestId:
        response.headers.get("x-typesafe-request-id") ??
        body.providerMetadata?.gateway?.generationId ??
        response.headers.get("x-request-id"),
      workerPid: process.pid,
    };
  } catch (error) {
    if (error instanceof ProviderFailure) throw error;
    if (error instanceof JevError && error.code === "INPUT_SIZE")
      throw new ProviderFailure("PROVIDER_RESPONSE_TOO_LARGE", false);
    if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name))
      throw new ProviderFailure("PROVIDER_TIMEOUT", true);
    throw new ProviderFailure("PROVIDER_NETWORK", true);
  }
}
