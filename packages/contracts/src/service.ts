import { z } from "zod";

/**
 * The AI Engineer database release a process started on (VER-S1): what the database stated through
 * `api.database_release()` (`release`, `state`), the releases this service works with (`range`), the verdict of the
 * rule shared with the AI Engineer service and Mission Control, and the mode the check ran in
 * (`AIENG_DB_RELEASE_CHECK`). `not_checked` is the verdict of mode `off`. Read once at startup (`checkedAt`).
 */
export const DatabaseReleaseStatusSchema = z.strictObject({
  check: z.enum(["enforce", "warn", "off"]),
  range: z.string(),
  release: z.string().nullable(),
  state: z.string().nullable(),
  verdict: z.enum(["ok", "unknown", "unstamped", "incompatible", "inconsistent", "not_checked"]),
  warning: z.boolean(),
  checkedAt: z.string(),
});
export type DatabaseReleaseStatus = z.infer<typeof DatabaseReleaseStatusSchema>;

export const ServiceStatusSchema = z.strictObject({
  service: z.literal("knowledge-services"),
  status: z.enum(["ready", "degraded"]),
  contractVersion: z.literal("v1"),
  runtime: z.literal("node"),
  /** Present when the process runs with persistence on the AI Engineer database. */
  databaseRelease: DatabaseReleaseStatusSchema.optional(),
});
export type ServiceStatus = z.infer<typeof ServiceStatusSchema>;
