import { z } from "zod";

export const jevStateSchema = z.union([z.string(), z.record(z.string(), z.json()), z.array(z.json())]);
const description = z.union([jevStateSchema, z.null()]);
const instructions = jevStateSchema;
export const jevQuestionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("choice"),
      instructions,
      criteria: z
        .record(z.string().min(1), description)
        .refine((v) => Object.keys(v).length >= 1 && Object.keys(v).length <= 255, "Choice requires 1–255 options"),
    })
    .strict(),
  z.object({ type: z.literal("score"), instructions, criteria: z.array(jevStateSchema).min(2).max(10) }).strict(),
  z
    .object({
      type: z.literal("noul"),
      instructions,
      criteria: z.object({ true: description, false: description }).strict().optional(),
    })
    .strict(),
]);
export const jevQuestionsSchema = z
  .record(z.string().min(1).max(200), jevQuestionSchema)
  .refine((v) => Object.keys(v).length >= 1 && Object.keys(v).length <= 2000, "Request requires 1–2000 questions");
export const jevInputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("inline"), state: jevStateSchema }).strict(),
  z.object({ type: z.literal("file"), path: z.string().min(1), format: z.enum(["text", "json"]).optional() }).strict(),
  z.object({ type: z.literal("remote"), url: z.url(), format: z.enum(["text", "json"]).optional() }).strict(),
]);
export const jevTaskSchema = z
  .object({
    idempotencyKey: z.string().min(1).max(200).optional(),
    input: jevInputSchema,
    questions: jevQuestionsSchema,
    provider: z.enum(["gateway", "direct"]).optional(),
    model: z.string().min(1).max(200).optional(),
  })
  .strict();
export const jevBatchSchema = z.array(jevTaskSchema).min(1).max(1000);
export type JevState = z.infer<typeof jevStateSchema>;
export type JevQuestion = z.infer<typeof jevQuestionSchema>;
export type JevQuestions = z.infer<typeof jevQuestionsSchema>;
export type JevInput = z.infer<typeof jevInputSchema>;
export type JevTask = z.infer<typeof jevTaskSchema>;
export type JevProvider = "gateway" | "direct";
export type JevJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type JevAnswer =
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence?: number }
  | { type: "score"; score: number; probabilities: Record<string, number>; confidence?: number }
  | { type: "noul"; noul: number };
export interface JevProvenance {
  type: JevInput["type"];
  source: string;
  sha256: string;
  bytes: number;
  capturedAt: string;
}
export interface JevResult {
  answers: Record<string, JevAnswer>;
  usage: { inputTokens: number; outputTokens: number };
  requestedModel: string;
  returnedModel: string | null;
  provider: JevProvider;
  latencyMs: number;
  requestId: string | null;
  workerPid: number;
}
export interface JevJob {
  id: string;
  status: JevJobStatus;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  requestDigest: string;
  provenance: JevProvenance;
  workerPid?: number;
  result?: JevResult;
  error?: { code: string; message: string };
}
export interface JevInputPolicy {
  allowedRoots: string[];
  remoteOrigins: string[];
  maxBytes?: number;
}
export interface JevProviderOptions {
  route: JevProvider;
  model?: string;
  endpoint?: string;
}
export interface JevServiceOptions {
  databasePath: string;
  workers?: number;
  provider?: JevProviderOptions;
  inputPolicy: JevInputPolicy;
  requestTimeoutMs?: number;
  maxAttempts?: number;
  maxQueuedJobs?: number;
  requestsPerMinute?: number;
}
export interface JevStats {
  counts: Record<JevJobStatus, number>;
  workers: { pid: number | null; busy: boolean; jobId: string | null }[];
}
export interface JevService {
  start(): Promise<void>;
  submit(task: JevTask): Promise<JevJob>;
  submitBatch(tasks: JevTask[]): Promise<JevJob[]>;
  get(id: string): JevJob | undefined;
  list(options?: { status?: JevJobStatus; limit?: number }): JevJob[];
  cancel(id: string): JevJob | undefined;
  stats(): JevStats;
  close(): Promise<void>;
}
export interface ResolvedJevRequest {
  state: JevState;
  questions: JevQuestions;
  provider: JevProvider;
  model: string;
}
export class JevError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "JevError";
  }
}

const probability = z.number().min(0).max(1);
export const JevStatusSchema = z.enum(["queued", "running", "succeeded", "failed", "cancelled"]);
export const JevAnswerSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("choice"),
    choice: z.string(),
    probabilities: z.record(z.string(), probability),
    confidence: probability.optional(),
  }),
  z.object({
    type: z.literal("score"),
    score: z.number().finite(),
    probabilities: z.record(z.string(), probability),
    confidence: probability.optional(),
  }),
  z.object({ type: z.literal("noul"), noul: probability }),
]);
export const JevResultSchema = z.object({
  answers: z.record(z.string(), JevAnswerSchema),
  usage: z.object({ inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative() }),
  requestedModel: z.string(),
  returnedModel: z.string().nullable(),
  provider: z.enum(["gateway", "direct"]),
  latencyMs: z.number().nonnegative(),
  requestId: z.string().nullable(),
  workerPid: z.number().int(),
});
export const JevProvenanceSchema = z.object({
  type: z.enum(["inline", "file", "remote"]),
  source: z.string(),
  sha256: z.string(),
  bytes: z.number().nonnegative(),
  capturedAt: z.string(),
});
export const JevJobSchema = z.object({
  id: z.string(),
  status: JevStatusSchema,
  attempts: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  requestDigest: z.string(),
  provenance: JevProvenanceSchema,
  workerPid: z.number().int().optional(),
  result: JevResultSchema.optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export const JevStatsSchema = z.object({
  counts: z.object({
    queued: z.number(),
    running: z.number(),
    succeeded: z.number(),
    failed: z.number(),
    cancelled: z.number(),
  }),
  workers: z.array(z.object({ pid: z.number().nullable(), busy: z.boolean(), jobId: z.string().nullable() })),
});
export const JevTaskSchema = jevTaskSchema;
export const JevBatchSchema = jevBatchSchema;
