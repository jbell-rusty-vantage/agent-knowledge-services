import type { ResearchBinding } from "@aiengineer/knowledge-application";
import { type Ref, refOf, sameRef } from "@aiengineer/knowledge-operation-protocol";
import {
  type AuthScope,
  type DerivedProposals,
  DomainMappingSchema,
  authoritativeObservations,
  evaluateSupport,
  recordRef,
  reportDerive,
} from "@aiengineer/knowledge-research-core";
import { z } from "zod";
import { type Correlation, refusal } from "./errors.js";

/**
 * `report.derive` over K01 (`nativeContract: research-report-derive/v1`, inline `{report, mapping}`): the research-core
 * deterministic compiler (`reportDerive`, design §3.2) over the exact frozen revision of the report and the support the
 * run's AUTHORITATIVE observations give (producer observations never count). Only explicitly supported assertion fields
 * are compiled through the declared mapping rules; unresolved entity/time mappings hold individual items. No model
 * call, no entity resolution, no write to any domain store: the result is the proposals document (custody), which a
 * later exact-use decision and `knowledge.apply` may admit.
 */
export const DERIVED_PROPOSALS_SCHEMA_VERSION = "research-core.derived_proposals.v1" as const;

export const DeriveRequestSchema = z.strictObject({
  report: refOf("report"),
  mapping: z.record(z.string(), z.unknown()),
});

export interface DerivedDocument extends DerivedProposals {
  readonly schemaVersion: typeof DERIVED_PROPOSALS_SCHEMA_VERSION;
  readonly runId: string;
}

export async function deriveReport(
  scope: AuthScope,
  binding: ResearchBinding,
  input: { readonly runId: string; readonly report: Ref<"report">; readonly mapping: Record<string, unknown> },
  correlation: Correlation,
): Promise<{ readonly document: DerivedDocument; readonly state: "succeeded" | "partial" | "held" }> {
  const mapping = DomainMappingSchema.parse(input.mapping);
  if (mapping.tenant !== scope.tenant || mapping.binding !== scope.binding) {
    throw refusal("SCOPE_DENIED", "the mapping names another tenant or binding", correlation);
  }
  const context = await binding.loadRunContext(scope, input.runId);
  const revision = context.report?.revision;
  if (revision === undefined || !sameRef(recordRef("report", revision), input.report)) {
    throw refusal("EXACT_REVISION_UNAVAILABLE", "the exact report revision is not in its run", correlation);
  }
  const observations = authoritativeObservations(context.observations);
  const storeScope = { tenant: scope.tenant, binding: scope.binding };
  const support = context.assertions.map((assertion) =>
    evaluateSupport({
      scope: storeScope,
      assertion,
      assertions: context.assertions,
      supportSets: context.supportSets,
      observations,
    }),
  );
  const derived = reportDerive({ revision, assertions: context.assertions, support, mapping });
  const state =
    derived.proposals.length === 0 ? "held" : derived.held.length === 0 ? "succeeded" : ("partial" as const);
  return {
    document: { schemaVersion: DERIVED_PROPOSALS_SCHEMA_VERSION, runId: input.runId, ...derived },
    state,
  };
}
