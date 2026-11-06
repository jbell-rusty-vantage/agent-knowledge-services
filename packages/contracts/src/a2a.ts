import { z } from "zod";
import { OperationContextSchema } from "./identity.js";
import {
  ArtifactReferenceSchema,
  ContractVersionSchema,
  JsonValueSchema,
  NonEmptyStringSchema,
  UuidSchema,
} from "./primitives.js";

export const A2ATaskKindSchema = z.enum([
  "document_preparation",
  "vector_store_ingestion",
  "retrieval",
  "evidence_packet_construction",
]);
export const A2AOperationBindingSchema = z.strictObject({
  taskId: UuidSchema,
  kind: A2ATaskKindSchema,
  purpose: NonEmptyStringSchema,
  inputArtifactIds: z.array(UuidSchema),
  expectedOutputContract: NonEmptyStringSchema,
  callback: z.strictObject({
    url: z.string().url(),
    authenticationReference: NonEmptyStringSchema,
    signingKeyReference: NonEmptyStringSchema,
  }),
});
export type A2AOperationBinding = z.infer<typeof A2AOperationBindingSchema>;
export const A2ATaskSchema = z.strictObject({
  taskId: UuidSchema,
  kind: A2ATaskKindSchema,
  contractVersion: ContractVersionSchema,
  context: OperationContextSchema,
  purpose: NonEmptyStringSchema,
  capabilityVersions: z.record(z.string(), NonEmptyStringSchema),
  expectedOutputContract: NonEmptyStringSchema,
  inputArtifactIds: z.array(UuidSchema),
  /** The actual operation input; A2A metadata is never substituted for executable work. */
  operationInput: JsonValueSchema,
  callback: A2AOperationBindingSchema.shape.callback,
});
export type A2ATask = z.infer<typeof A2ATaskSchema>;

export const A2AStatusSchema = z.strictObject({
  taskId: UuidSchema,
  operationId: UuidSchema,
  state: z.enum(["accepted", "running", "needs_review", "succeeded", "failed", "cancelled"]),
  statusUrl: z.string().url(),
  eventStreamUrl: z.string().url(),
  cancellationUrl: z.string().url(),
});
export type A2AStatus = z.infer<typeof A2AStatusSchema>;
export const A2AResultSchema = z.strictObject({
  taskId: UuidSchema,
  operationId: UuidSchema,
  outcome: z.enum(["succeeded", "failed", "cancelled"]),
  artifacts: z.array(ArtifactReferenceSchema),
  evidencePacketIds: z.array(UuidSchema),
  receiptIds: z.array(UuidSchema),
  warnings: z.array(NonEmptyStringSchema),
});
export type A2AResult = z.infer<typeof A2AResultSchema>;
