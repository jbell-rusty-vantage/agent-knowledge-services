import { z } from "zod";

export const ServiceStatusSchema = z.strictObject({
  service: z.literal("knowledge-services"),
  status: z.enum(["ready", "degraded"]),
  contractVersion: z.literal("v1"),
  runtime: z.literal("node"),
});
export type ServiceStatus = z.infer<typeof ServiceStatusSchema>;
