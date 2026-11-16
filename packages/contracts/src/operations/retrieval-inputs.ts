import { z } from "zod";
import { A2AOperationBindingSchema } from "../a2a.js";
import { EvidencePacketSchema, RetrievalPlanSchema } from "../retrieval.js";

/** Input of the `evidence_packet` operation: one complete evidence packet to store under its plan and run. */
export const EvidencePacketInputSchema = z.strictObject({
  planId: z.uuid(),
  runId: z.uuid(),
  packetId: z.uuid(),
  packet: EvidencePacketSchema,
  a2a: A2AOperationBindingSchema.optional(),
});

/** Input of retrieval plan validation: the plan to check. */
export const RetrievalPlanValidationInputSchema = z.strictObject({ plan: RetrievalPlanSchema });

/** Input of the retrieval run and explanation reads. */
export const RetrievalRunReadInputSchema = z.strictObject({ runId: z.uuid() });

/** Input of the evidence packet read and of citation replay. */
export const EvidencePacketReadInputSchema = z.strictObject({ packetId: z.uuid() });

/** Input of an operation status read. */
export const OperationReadInputSchema = z.strictObject({ operationId: z.uuid() });

/** Input of the status read of an operation that belongs to one vector store. */
export const VectorStoreOperationReadInputSchema = z.strictObject({
  vectorStoreId: z.uuid(),
  operationId: z.uuid(),
});

/** Input of a read that takes no fields. */
export const EmptyInputSchema = z.strictObject({});
