import { IdSchema, InstantSchema, PositiveIntSchema, refOf } from "@aiengineer/knowledge-operation-protocol";
import type { AuthScope } from "@aiengineer/knowledge-research-core";
import { z } from "zod";
import { type Correlation, refusal } from "./errors.js";

/**
 * The native payload of `report.register` over K01 (`nativeContract: research-report/v2`, inline). One registration is
 * one effect: it freezes the task, opens a fresh run (originating origin = the effect's), registers the producer's
 * evidence fragments, assertions and support sets, then renders, freezes and registers the report revision against its
 * pinned K08 kind. Records are validated by research-core inside the coordinator (strict K02 schemas); this envelope
 * only shapes them. Judge, auditor and reviewer observations are never accepted from the producer here: the independent
 * census and judgments are recorded by their own services, so a producer cannot verify itself.
 */
const IntervalSchema = z.strictObject({ from: InstantSchema.nullable(), to: InstantSchema.nullable() });

export const RegistrationPayloadSchema = z.strictObject({
  task: z.record(z.string(), z.unknown()),
  fragments: z.array(z.record(z.string(), z.unknown())).max(500).default([]),
  assertions: z.array(z.record(z.string(), z.unknown())).min(1).max(500),
  supportSets: z.array(z.record(z.string(), z.unknown())).max(500).default([]),
  report: z.strictObject({
    reportId: IdSchema,
    revision: PositiveIntSchema,
    /** A K08 kind id (`evidence_report`, resolved to the pinned latest version) or the exact pinned kind ref. */
    kind: z.union([z.string().regex(/^[a-z][a-z0-9_]{0,59}$/), refOf("report_kind")]),
    structuredBody: z.record(z.string(), z.unknown()),
    timeCoverage: z
      .strictObject({
        world: IntervalSchema.nullable(),
        observed: IntervalSchema.nullable(),
        knowledgeHead: z.string().max(200).nullable(),
      })
      .default({ world: null, observed: null, knowledgeHead: null }),
    supersedes: refOf("report").nullable().default(null),
  }),
});
export type RegistrationPayload = z.infer<typeof RegistrationPayloadSchema>;

/** Every record the producer sends names this scope's tenant and binding (K03: caller hints never widen scope). */
export function assertRecordsInScope(scope: AuthScope, payload: RegistrationPayload, correlation: Correlation): void {
  const records = [payload.task, ...payload.fragments, ...payload.assertions, ...payload.supportSets];
  for (const record of records) {
    const tenant = record.tenant;
    const binding = record.binding;
    if ((tenant !== undefined && tenant !== scope.tenant) || (binding !== undefined && binding !== scope.binding)) {
      throw refusal("SCOPE_DENIED", "a registered record names another tenant or binding", correlation);
    }
  }
  const refs = [payload.report.supersedes, typeof payload.report.kind === "string" ? null : payload.report.kind];
  for (const ref of refs) {
    if (ref !== null && (ref.tenant !== scope.tenant || ref.binding !== scope.binding)) {
      throw refusal("SCOPE_DENIED", "a referenced handle names another tenant or binding", correlation);
    }
  }
}
