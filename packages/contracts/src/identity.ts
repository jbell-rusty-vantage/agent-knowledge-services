import { z } from "zod";
import { ContractVersionSchema, IdempotencyKeySchema, NonEmptyStringSchema, UuidSchema } from "./primitives.js";

export const ServiceIdentitySchema = z.enum([
  "knowledge_api",
  "knowledge_worker",
  "acquisition_executor",
  "conversion_executor",
  "inspection_agent",
  "content_curator_agent",
  "embedding_executor",
  "retrieval_executor",
  "evaluation_executor",
  "human_reviewer",
  "mission_control_client",
  "retention_worker",
  "control_plane",
]);
export type ServiceIdentity = z.infer<typeof ServiceIdentitySchema>;

export const ActorSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("human"), id: UuidSchema, displayName: NonEmptyStringSchema.optional() }),
  z.strictObject({ kind: z.literal("service"), id: UuidSchema, serviceIdentity: ServiceIdentitySchema }),
  z.strictObject({
    kind: z.literal("model"),
    id: UuidSchema,
    serviceIdentity: z.enum(["inspection_agent", "content_curator_agent"]),
    model: NonEmptyStringSchema,
    providerRunId: NonEmptyStringSchema,
  }),
]);
export type Actor = z.infer<typeof ActorSchema>;

export const ExternalExecutionContextSchema = z.strictObject({
  runtime: z.enum(["eve", "vercel_workflow", "mission_control", "other"]),
  runId: NonEmptyStringSchema,
  rootRunId: NonEmptyStringSchema.optional(),
  sessionId: NonEmptyStringSchema.optional(),
  turnId: NonEmptyStringSchema.optional(),
  toolCallId: NonEmptyStringSchema.optional(),
});
export type ExternalExecutionContext = z.infer<typeof ExternalExecutionContextSchema>;

export const OperationContextSchema = z.strictObject({
  tenantId: UuidSchema,
  projectId: UuidSchema.optional(),
  operationId: UuidSchema,
  attemptId: UuidSchema,
  workItemId: UuidSchema.optional(),
  missionId: UuidSchema.optional(),
  correlationId: NonEmptyStringSchema,
  causationId: NonEmptyStringSchema.optional(),
  actor: ActorSchema,
  capabilityVersion: NonEmptyStringSchema,
  idempotencyKey: IdempotencyKeySchema,
  reason: NonEmptyStringSchema,
  contractVersion: ContractVersionSchema,
  externalExecution: ExternalExecutionContextSchema.optional(),
});
export type OperationContext = z.infer<typeof OperationContextSchema>;

export const AuthorizationDecisionSchema = z.strictObject({
  decisionId: UuidSchema,
  tenantId: UuidSchema,
  actorId: UuidSchema,
  action: NonEmptyStringSchema,
  resource: NonEmptyStringSchema,
  allowed: z.boolean(),
  policyVersion: UuidSchema,
  reasonCodes: z.array(NonEmptyStringSchema).min(1),
});
export type AuthorizationDecision = z.infer<typeof AuthorizationDecisionSchema>;
